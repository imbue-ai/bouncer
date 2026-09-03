//
//  StudyVideoComposer.swift
//  iOS (App)
//
//  Turns a recorded scroll-study session into a single shareable video
//  (summary.mp4): the participant's face and the reel they were watching
//  side by side, with the facial-expression graph drawing itself underneath
//  as the video plays.
//
//  Inputs (all in the session folder, written by ScrollStudy.swift):
//    • recordings.json    — "face"/"screen" -> [{file, startMs}, ...]; each
//                           video segment's wall-clock start, since segment
//                           PTS are zero-based
//    • face-N.mov         — front-camera video (ARKit frames or AVCapture)
//    • screen-N.mov       — 5 fps snapshots of the web view
//    • expressions.jsonl  — 10 Hz {t, smile, frown, surprise, tracked}
//    • meta.json          — t0Ms anchors the session timeline
//
//  Rendering: one pass over a fixed 20 fps timeline. Source videos are read
//  sequentially with AVAssetReader (each output frame shows the latest source
//  frame at or before its timestamp — snapshots naturally "hold"). The graph
//  strokes accumulate in a persistent transparent bitmap, so each frame only
//  strokes the newly-elapsed segments; static chrome (axes, labels, legend,
//  panel captions) is prerendered once and composited on top.
//
//  Everything is fixed-axis: x spans the whole session up front, y is the raw
//  0…1 blendshape range — the line literally "draws itself" left to right.
//

import Foundation
import AVFoundation
import CoreImage
import UIKit

// nonisolated, or the target's default MainActor isolation claims every member
// — but under this project's approachable-concurrency setting that is NOT
// enough to get off the main thread: nonisolated async functions run on the
// CALLER's actor by default (SE-0461), and the caller is a MainActor task.
// compose() itself therefore carries @concurrent below — the explicit "run on
// the background pool" — or the whole frame loop (decode, draw, encode, and a
// Thread.sleep backpressure wait) freezes the UI for the entire composition.
// Everything here is safe off-main: UIGraphicsImageRenderer / UIColor / UIFont
// / NSString.draw are documented thread-safe, and the AV readers/writer are
// pumped from this one call.
nonisolated enum StudyVideoComposer {

    struct ComposeError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private struct Sample {
        let t: Double          // session-relative seconds
        let tracked: Bool
        let values: [Double]   // one per series, same order as `series`
    }

    private struct Series {
        let key: String
        let label: String
        let color: UIColor
    }

    /// What the graph plots when a session recorded full blendshape vectors:
    /// the projection onto the session's own first principal component — the
    /// single axis this face moved along most, whatever that was. Sign is
    /// kept (zero = the session's mean expression, on the midline); the only
    /// normalization is division by one constant, the 99th percentile of the
    /// projection's magnitude. Axis −1…+1.
    private static let pc1Series: [Series] = [
        Series(key: "pc1", label: "Expression (PC1)",
               color: UIColor(red: 0.04, green: 0.52, blue: 1.00, alpha: 1)),
    ]

    /// Fallback for sessions without coef vectors (older recordings, or the
    /// no-TrueDepth camera path): the named derived metrics.
    private static let namedSeries: [Series] = [
        Series(key: "smile", label: "Smile", color: UIColor(red: 0.19, green: 0.82, blue: 0.35, alpha: 1)),
        Series(key: "frown", label: "Frown", color: UIColor(red: 1.00, green: 0.27, blue: 0.23, alpha: 1)),
        Series(key: "surprise", label: "Brow raise", color: UIColor(red: 0.04, green: 0.52, blue: 1.00, alpha: 1)),
    ]

    // MARK: layout (top-left coordinate space)

    private static let canvasW = 720
    private static let canvasH = 1080
    private static let faceRect = CGRect(x: 8, y: 8, width: 348, height: 620)
    private static let reelRect = CGRect(x: 364, y: 8, width: 348, height: 620)
    private static let graphRect = CGRect(x: 8, y: 640, width: 704, height: 432)
    /// Plot area inside graphRect: room for y labels left, legend top, x labels bottom.
    private static var plotRect: CGRect {
        CGRect(x: graphRect.minX + 52, y: graphRect.minY + 40,
               width: graphRect.width - 52 - 16, height: graphRect.height - 40 - 34)
    }

    private static let fps: Double = 20
    private static let maxDurationS: Double = 1800   // bound generation time
    /// The summary plays this many session-seconds per video-second — a scroll
    /// session reviews fine sped up, and it cuts composition work by the same
    /// factor (a third of the output frames for 3×).
    private static let speedup: Double = 3

    // MARK: - Entry point

    /// Compose summary.mp4 for a session folder. `progress` is called with
    /// 0…1 on an arbitrary thread. Returns the output URL.
    @concurrent
    static func compose(sessionDir: URL, progress: @escaping @Sendable (Double) -> Void) async throws -> URL {
        let fm = FileManager.default

        // --- gather inputs ---------------------------------------------------
        let recordings = loadRecordings(sessionDir)
        let t0Ms = loadT0Ms(sessionDir)
            ?? recordings.values.flatMap { $0 }.map(\.startMs).min()
        guard let t0Ms else {
            throw ComposeError(message: "No timeline anchor — nothing was recorded in this session.")
        }

        func makeSources(_ kind: String, fit: CGSize) async -> SegmentedSource {
            var readers: [SegmentReader] = []
            for seg in recordings[kind] ?? [] {
                let url = sessionDir.appendingPathComponent(seg.file)
                guard fm.fileExists(atPath: url.path) else { continue }
                if let r = await SegmentReader.open(url: url, startS: (seg.startMs - t0Ms) / 1000, fit: fit) {
                    readers.append(r)
                }
            }
            return SegmentedSource(readers: readers.sorted { $0.startS < $1.startS })
        }
        let face = await makeSources("face", fit: faceRect.size)
        let reel = await makeSources("screen", fit: reelRect.size)
        let (plotSeries, samples, yRange) = loadPlot(sessionDir, t0Ms: t0Ms)

        let rawDuration = max(face.endS, reel.endS, samples.last?.t ?? 0)
        guard rawDuration > 1 else {
            throw ComposeError(message: "Session too short (or no video/expression data) to compose.")
        }
        let duration = min(rawDuration, maxDurationS)

        // --- output writer ----------------------------------------------------
        let outURL = sessionDir.appendingPathComponent("summary.mp4")
        try? fm.removeItem(at: outURL)
        let writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: canvasW,
            AVVideoHeightKey: canvasH,
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: canvasW,
                kCVPixelBufferHeightKey as String: canvasH,
            ])
        guard writer.canAdd(input) else { throw ComposeError(message: "Cannot configure video writer.") }
        writer.add(input)
        guard writer.startWriting() else {
            throw ComposeError(message: writer.error?.localizedDescription ?? "Video writer failed to start.")
        }
        writer.startSession(atSourceTime: .zero)

        // --- prerendered pieces ----------------------------------------------
        let overlay = renderStaticOverlay(
            duration: duration, series: plotSeries, yRange: yRange,
            hasFace: !face.isEmpty, hasReel: !reel.isEmpty, hasSamples: !samples.isEmpty)
        let graphLayer = makeGraphLayer()
        var strokedUpTo = 0            // samples already stroked into graphLayer
        var graphImage: CGImage?       // cached copy, refreshed only when strokes land
        // The signed (PC1) graph is a wordless area fill around the zero axis;
        // the named fallback keeps its stroked lines, labels, and playhead.
        let signedFill = yRange.lowerBound < 0
        let ciContext = CIContext(options: [.workingColorSpace: NSNull()])

        // --- frame loop --------------------------------------------------------
        // Each output frame advances `speedup / fps` seconds of session time;
        // PTS advance at 1 / fps — that ratio IS the fast-forward.
        let frameCount = Int(duration / speedup * fps)
        for i in 0..<frameCount {
            if Task.isCancelled {
                writer.cancelWriting()
                throw CancellationError()
            }
            let t = Double(i) / fps * speedup

            while !input.isReadyForMoreMediaData {
                if writer.status != .writing {
                    throw ComposeError(message: writer.error?.localizedDescription ?? "Video writer failed.")
                }
                Thread.sleep(forTimeInterval: 0.005)
            }

            var pixelBuffer: CVPixelBuffer?
            if let pool = adaptor.pixelBufferPool {
                CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixelBuffer)
            }
            guard let buffer = pixelBuffer else {
                throw ComposeError(message: "Could not allocate a frame buffer.")
            }

            try autoreleasepool {
                CVPixelBufferLockBaseAddress(buffer, [])
                defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
                guard let ctx = CGContext(
                    data: CVPixelBufferGetBaseAddress(buffer),
                    width: canvasW, height: canvasH,
                    bitsPerComponent: 8,
                    bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                        | CGBitmapInfo.byteOrder32Little.rawValue
                ) else {
                    throw ComposeError(message: "Could not create a drawing context.")
                }
                // Flip to a top-left origin so all layout math reads naturally;
                // drawImage() un-flips locally for image blits.
                ctx.translateBy(x: 0, y: CGFloat(canvasH))
                ctx.scaleBy(x: 1, y: -1)

                ctx.setFillColor(UIColor(red: 0.055, green: 0.055, blue: 0.07, alpha: 1).cgColor)
                ctx.fill(CGRect(x: 0, y: 0, width: canvasW, height: canvasH))
                ctx.setFillColor(UIColor.black.cgColor)
                ctx.fill(faceRect)
                ctx.fill(reelRect)

                if let img = face.image(at: t, ci: ciContext) {
                    drawAspectFill(img, in: faceRect, ctx: ctx)
                }
                if let img = reel.image(at: t, ci: ciContext) {
                    drawAspectFill(img, in: reelRect, ctx: ctx)
                }

                // Graph: stroke newly-elapsed segments into the persistent
                // layer, then composite it.
                let stroked = signedFill
                    ? fillNewSegments(
                        into: graphLayer, samples: samples, from: strokedUpTo,
                        upTo: t, duration: duration)
                    : strokeNewSegments(
                        into: graphLayer, series: plotSeries, samples: samples, from: strokedUpTo,
                        upTo: t, duration: duration)
                // makeImage() copies the whole canvas-sized layer; only pay for
                // it on frames that actually added strokes.
                if stroked != strokedUpTo || graphImage == nil {
                    strokedUpTo = stroked
                    graphImage = graphLayer.makeImage()
                }
                if let graphImage {
                    drawImage(graphImage, in: CGRect(x: 0, y: 0, width: canvasW, height: canvasH), ctx: ctx)
                }
                drawImage(overlay, in: CGRect(x: 0, y: 0, width: canvasW, height: canvasH), ctx: ctx)
                if !signedFill {
                    // The fill's advancing edge is its own time cursor; only
                    // the stroked fallback needs the playhead.
                    drawPlayhead(at: t, duration: duration, series: plotSeries,
                                 samples: samples, upTo: strokedUpTo, ctx: ctx)
                }
            }

            let pts = CMTime(seconds: Double(i) / fps, preferredTimescale: 600)
            guard adaptor.append(buffer, withPresentationTime: pts) else {
                throw ComposeError(message: writer.error?.localizedDescription ?? "Failed to append a frame.")
            }
            if i % 24 == 0 { progress(Double(i) / Double(frameCount)) }
        }

        input.markAsFinished()
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            writer.finishWriting { cont.resume() }
        }
        guard writer.status == .completed else {
            throw ComposeError(message: writer.error?.localizedDescription ?? "Video writer did not finish.")
        }
        progress(1)
        return outURL
    }

    // MARK: - Input parsing

    private struct SegmentRef {
        let file: String
        let startMs: Double
    }

    private static func loadRecordings(_ dir: URL) -> [String: [SegmentRef]] {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("recordings.json")),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: [[String: Any]]] else {
            return [:]
        }
        return obj.mapValues { entries in
            entries.compactMap { e in
                guard let file = e["file"] as? String, let startMs = e["startMs"] as? Double else { return nil }
                return SegmentRef(file: file, startMs: startMs)
            }
        }
    }

    private static func loadT0Ms(_ dir: URL) -> Double? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("meta.json")),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        return obj["t0Ms"] as? Double
    }

    private struct RawSample {
        let t: Double
        let tracked: Bool
        let obj: [String: Any]
    }

    /// The graph's series, samples, and y-axis range for a session: PC1 of
    /// the blendshape vectors when they were recorded (signed, −1…+1), the
    /// named derived metrics otherwise (raw blendshape 0…1). Sample values are
    /// always stored in 0…1 plot space; `yRange` is what the axis labels say.
    private static func loadPlot(_ dir: URL, t0Ms: Double)
        -> (series: [Series], samples: [Sample], yRange: ClosedRange<Double>) {
        guard let text = try? String(contentsOf: dir.appendingPathComponent("expressions.jsonl"),
                                     encoding: .utf8) else { return (namedSeries, [], 0...1) }
        var raws: [RawSample] = []
        for line in text.split(separator: "\n") {
            guard let data = line.data(using: .utf8),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let t = obj["t"] as? Double else { continue }
            raws.append(RawSample(t: (t - t0Ms) / 1000,
                                  tracked: (obj["tracked"] as? Bool) ?? false,
                                  obj: obj))
        }
        raws.sort { $0.t < $1.t }
        if let pc1 = pc1Samples(raws) { return (pc1Series, pc1, -1...1) }
        return (namedSeries, raws.map { r in
            Sample(t: r.t, tracked: r.tracked,
                   values: namedSeries.map { (r.obj[$0.key] as? Double) ?? 0 })
        }, 0...1)
    }

    // MARK: - PC1

    /// Fit PCA over the session's own blendshape vectors and project every
    /// sample onto the first component — one line that captures however THIS
    /// face moved most, rather than three axes chosen in advance. The fit is
    /// per-session (there is no cross-session basis to be had on device), so
    /// the y scale is the session's 1st–99th percentile mapped to 0…1, and the
    /// sign is oriented smile-positive so "up" reads the same across videos.
    /// Returns nil when the session lacks coef data — the caller falls back to
    /// the named series.
    private static func pc1Samples(_ raws: [RawSample]) -> [Sample]? {
        let coefRaws: [(raw: RawSample, coefs: [String: Double])] = raws.compactMap { r in
            guard let c = r.obj["coefs"] as? [String: Double], !c.isEmpty else { return nil }
            return (r, c)
        }
        let tracked = coefRaws.filter { $0.raw.tracked }
        // Under ~10s of tracked face is too little to fit a basis worth a graph.
        guard tracked.count >= 100 else { return nil }

        var keySet = Set<String>()
        for (_, c) in tracked { keySet.formUnion(c.keys) }
        let keys = keySet.sorted()
        guard keys.count >= 2 else { return nil }
        func vector(_ c: [String: Double]) -> [Double] { keys.map { c[$0] ?? 0 } }

        var mean = [Double](repeating: 0, count: keys.count)
        for (_, c) in tracked {
            let v = vector(c)
            for j in mean.indices { mean[j] += v[j] }
        }
        for j in mean.indices { mean[j] /= Double(tracked.count) }

        // Fit on an even subsample (cost cap); project everything afterwards.
        let step = max(1, tracked.count / 4000)
        var rows: [[Double]] = []
        var i = 0
        while i < tracked.count {
            var v = vector(tracked[i].coefs)
            for j in v.indices { v[j] -= mean[j] }
            rows.append(v)
            i += step
        }
        guard var pc = firstPrincipalComponent(rows) else { return nil }

        // Sign: PCA's is arbitrary. Orient smile-positive when smile loads at
        // all; else make the dominant loading positive. Deterministic either way.
        let smileLoad = keys.indices
            .filter { keys[$0].lowercased().contains("smile") }
            .reduce(0.0) { $0 + pc[$1] }
        let orient: Double = smileLoad != 0
            ? smileLoad
            : (pc.max(by: { abs($0) < abs($1) }) ?? 1)
        if orient < 0 { for j in pc.indices { pc[j] = -pc[j] } }

        let projected: [(raw: RawSample, p: Double)] = coefRaws.map { (r, c) in
            let v = vector(c)
            var dot = 0.0
            for j in pc.indices { dot += (v[j] - mean[j]) * pc[j] }
            return (r, dot)
        }
        // Sign-preserving scale: divide by ONE constant (the 99th percentile
        // of |projection|, so a single spike can't flatten the line) and keep
        // zero where PCA put it — the session's mean expression sits at the
        // graph's midline, excursions keep their direction. Values land in
        // plot space as (v+1)/2; the overlay labels the axis −1…+1.
        let spread = projected.filter { $0.raw.tracked }.map { abs($0.p) }.sorted()
        let s = spread[Int(Double(spread.count - 1) * 0.99)]
        guard s > 1e-9 else { return nil }
        return projected.map { (r, p) in
            let v = min(1.0, max(-1.0, p / s))
            return Sample(t: r.t, tracked: r.tracked, values: [(v + 1) / 2])
        }
    }

    /// Top eigenvector of the sample covariance, by power iteration over the
    /// mean-centered rows (covariance-free: v ← Σ xᵢ(xᵢ·v), normalized). ~50
    /// passes is plenty for a dominant component; a degenerate cloud (norm
    /// collapses) returns nil.
    private static func firstPrincipalComponent(_ rows: [[Double]]) -> [Double]? {
        guard let d = rows.first?.count, d > 0, rows.count > 8 else { return nil }
        var v = [Double](repeating: 1 / Double(d).squareRoot(), count: d)
        for _ in 0..<50 {
            var next = [Double](repeating: 0, count: d)
            for row in rows {
                var dot = 0.0
                for j in 0..<d { dot += row[j] * v[j] }
                for j in 0..<d { next[j] += dot * row[j] }
            }
            let norm = next.reduce(0) { $0 + $1 * $1 }.squareRoot()
            guard norm > 1e-12 else { return nil }
            for j in 0..<d { next[j] /= norm }
            v = next
        }
        return v
    }

    // MARK: - Sequential segment readers

    /// One video file positioned on the session timeline. Frames are pulled
    /// sequentially; `image(at:)` returns the latest frame at or before the
    /// requested time (held once the file runs out — snapshots-style).
    private final class SegmentReader {
        let startS: Double
        let endS: Double
        private let transform: CGAffineTransform
        /// The panel this feeds. Frames are downscaled to it BEFORE the GPU→CPU
        /// copy — ReplayKit records at full device resolution, ~25× the panel's
        /// pixels, and converting at that size was where composition time went.
        private let fit: CGSize
        private var reader: AVAssetReader?
        private var output: AVAssetReaderTrackOutput?
        private var pending: (t: Double, buffer: CVPixelBuffer)?
        private var lastImage: CGImage?
        private var lastImageT = -Double.infinity

        private init(startS: Double, endS: Double, transform: CGAffineTransform, fit: CGSize,
                     reader: AVAssetReader, output: AVAssetReaderTrackOutput) {
            self.startS = startS
            self.endS = endS
            self.transform = transform
            self.fit = fit
            self.reader = reader
            self.output = output
        }

        static func open(url: URL, startS: Double, fit: CGSize) async -> SegmentReader? {
            let asset = AVURLAsset(url: url)
            guard let track = try? await asset.loadTracks(withMediaType: .video).first,
                  let duration = try? await asset.load(.duration),
                  let transform = try? await track.load(.preferredTransform),
                  let reader = try? AVAssetReader(asset: asset) else { return nil }
            let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            ])
            output.alwaysCopiesSampleData = false
            guard reader.canAdd(output) else { return nil }
            reader.add(output)
            guard reader.startReading() else { return nil }
            return SegmentReader(startS: startS, endS: startS + duration.seconds,
                                 transform: transform, fit: fit, reader: reader, output: output)
        }

        func image(at sessionT: Double, ci: CIContext) -> CGImage? {
            let t = sessionT - startS
            // Drain everything that has elapsed, but convert only the NEWEST
            // elapsed frame: at 3× playback several source frames can fall
            // inside one output step, and converting frames nobody sees was
            // pure waste.
            var newest: (t: Double, buffer: CVPixelBuffer)?
            while let output {
                if let p = pending {
                    if p.t <= t {
                        newest = p
                        pending = nil
                    } else {
                        break
                    }
                } else {
                    guard let sb = output.copyNextSampleBuffer(),
                          let ib = CMSampleBufferGetImageBuffer(sb) else {
                        close()   // drained — hold the last frame forever
                        break
                    }
                    pending = (CMSampleBufferGetPresentationTimeStamp(sb).seconds, ib)
                }
            }
            if let newest {
                lastImage = convert(newest.buffer, ci: ci)
                lastImageT = newest.t
            }
            return lastImageT <= t ? lastImage : nil
        }

        func close() {
            reader?.cancelReading()
            reader = nil
            output = nil
            pending = nil
        }

        private func convert(_ buffer: CVPixelBuffer, ci: CIContext) -> CGImage? {
            var img = CIImage(cvPixelBuffer: buffer)
            // preferredTransform is written in QuickTime's top-left space;
            // CIImage lives in a bottom-left space, where the same matrix
            // rotates the OTHER way — applying it directly played the face
            // upside down. Extract the angle and rotate opposite. (Rotation
            // only: none of our recordings mirror.)
            let angle = atan2(transform.b, transform.a)
            if angle != 0 {
                img = img.transformed(by: CGAffineTransform(rotationAngle: -angle))
            }
            let scale = min(1, max(fit.width / img.extent.width, fit.height / img.extent.height))
            if scale < 1 {
                img = img.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            }
            img = img.transformed(by: CGAffineTransform(translationX: -img.extent.minX,
                                                        y: -img.extent.minY))
            return ci.createCGImage(img, from: img.extent)
        }
    }

    /// All segments of one recording kind, walked in timeline order (the
    /// composition loop's time is monotonic, so this only ever moves forward).
    private final class SegmentedSource {
        private var readers: [SegmentReader]
        private var idx = 0

        init(readers: [SegmentReader]) { self.readers = readers }

        var isEmpty: Bool { readers.isEmpty }
        var endS: Double { readers.map(\.endS).max() ?? 0 }

        func image(at t: Double, ci: CIContext) -> CGImage? {
            guard !readers.isEmpty else { return nil }
            while idx + 1 < readers.count, readers[idx + 1].startS <= t {
                readers[idx].close()
                idx += 1
            }
            guard readers[idx].startS <= t else { return nil }
            return readers[idx].image(at: t, ci: ci)
        }
    }

    // MARK: - Graph

    private static func makeGraphLayer() -> CGContext {
        // Transparent full-canvas layer the polylines accumulate into.
        let ctx = CGContext(
            data: nil, width: canvasW, height: canvasH,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                | CGBitmapInfo.byteOrder32Little.rawValue)!
        ctx.translateBy(x: 0, y: CGFloat(canvasH))
        ctx.scaleBy(x: 1, y: -1)
        ctx.setLineWidth(2)
        ctx.setLineJoin(.round)
        ctx.setLineCap(.round)
        return ctx
    }

    private static func plotPoint(_ sample: Sample, seriesIdx: Int, duration: Double) -> CGPoint {
        let p = plotRect
        let x = p.minX + p.width * CGFloat(sample.t / duration)
        let y = p.minY + p.height * CGFloat(1 - min(1, max(0, sample.values[seriesIdx])))
        return CGPoint(x: x, y: y)
    }

    /// Stroke segments between consecutive samples whose time has elapsed.
    /// Returns the new "stroked up to" index. A gap (face lost, capture
    /// toggled off, >1s between samples) breaks the line.
    private static func strokeNewSegments(into layer: CGContext, series: [Series], samples: [Sample],
                                          from: Int, upTo t: Double, duration: Double) -> Int {
        guard !samples.isEmpty else { return 0 }
        var i = from
        layer.saveGState()
        layer.clip(to: plotRect)
        while i + 1 < samples.count, samples[i + 1].t <= t {
            let a = samples[i], b = samples[i + 1]
            i += 1
            guard a.tracked, b.tracked, b.t - a.t <= 1.0 else { continue }
            for (s, spec) in series.enumerated() {
                layer.setStrokeColor(spec.color.cgColor)
                layer.move(to: plotPoint(a, seriesIdx: s, duration: duration))
                layer.addLine(to: plotPoint(b, seriesIdx: s, duration: duration))
                layer.strokePath()
            }
        }
        layer.restoreGState()
        return i
    }

    /// The signed graph's renderer: fill the area between the curve and the
    /// zero axis, green where the value is positive and red where negative,
    /// splitting any segment that crosses zero so each side keeps its color.
    /// Same incremental contract as strokeNewSegments; gaps break the fill the
    /// same way they break the line.
    private static func fillNewSegments(into layer: CGContext, samples: [Sample],
                                        from: Int, upTo t: Double, duration: Double) -> Int {
        guard !samples.isEmpty else { return 0 }
        let zeroY = plotRect.midY
        let green = UIColor(red: 0.19, green: 0.82, blue: 0.35, alpha: 0.62).cgColor
        let red = UIColor(red: 1.00, green: 0.27, blue: 0.23, alpha: 0.62).cgColor
        func fill(_ pts: [CGPoint], positive: Bool) {
            layer.setFillColor(positive ? green : red)
            layer.move(to: pts[0])
            for q in pts.dropFirst() { layer.addLine(to: q) }
            layer.closePath()
            layer.fillPath()
        }
        var i = from
        layer.saveGState()
        layer.clip(to: plotRect)
        while i + 1 < samples.count, samples[i + 1].t <= t {
            let a = samples[i], b = samples[i + 1]
            i += 1
            guard a.tracked, b.tracked, b.t - a.t <= 1.0 else { continue }
            let pa = plotPoint(a, seriesIdx: 0, duration: duration)
            let pb = plotPoint(b, seriesIdx: 0, duration: duration)
            // Signed values around the midline, in plot space (0.5 = zero).
            let sa = a.values[0] - 0.5, sb = b.values[0] - 0.5
            if sa == 0 && sb == 0 { continue }
            if sa * sb >= 0 {
                fill([CGPoint(x: pa.x, y: zeroY), pa, pb, CGPoint(x: pb.x, y: zeroY)],
                     positive: sa + sb > 0)
            } else {
                // The segment crosses zero: color each side its own way.
                let f = sa / (sa - sb)
                let cross = CGPoint(x: pa.x + (pb.x - pa.x) * f, y: zeroY)
                fill([CGPoint(x: pa.x, y: zeroY), pa, cross], positive: sa > 0)
                fill([cross, pb, CGPoint(x: pb.x, y: zeroY)], positive: sb > 0)
            }
        }
        layer.restoreGState()
        return i
    }

    /// Vertical playhead line plus a dot per series at the latest value.
    private static func drawPlayhead(at t: Double, duration: Double, series: [Series],
                                     samples: [Sample], upTo: Int, ctx: CGContext) {
        let p = plotRect
        let x = p.minX + p.width * CGFloat(t / duration)
        ctx.setStrokeColor(UIColor.white.withAlphaComponent(0.55).cgColor)
        ctx.setLineWidth(1)
        ctx.move(to: CGPoint(x: x, y: p.minY))
        ctx.addLine(to: CGPoint(x: x, y: p.maxY))
        ctx.strokePath()

        guard !samples.isEmpty else { return }
        let latest = samples[min(upTo, samples.count - 1)]
        guard latest.tracked, t - latest.t <= 1.0 else { return }
        for (s, spec) in series.enumerated() {
            let pt = plotPoint(latest, seriesIdx: s, duration: duration)
            ctx.setFillColor(spec.color.cgColor)
            ctx.fillEllipse(in: CGRect(x: pt.x - 4, y: pt.y - 4, width: 8, height: 8))
        }
    }

    // MARK: - Static chrome (rendered once)

    private static func renderStaticOverlay(duration: Double, series: [Series],
                                            yRange: ClosedRange<Double>,
                                            hasFace: Bool, hasReel: Bool,
                                            hasSamples: Bool) -> CGImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let renderer = UIGraphicsImageRenderer(
            size: CGSize(width: canvasW, height: canvasH), format: format)

        let image = renderer.image { rctx in
            let ctx = rctx.cgContext
            let hairline = UIColor.white.withAlphaComponent(0.18)
            let textColor = UIColor.white.withAlphaComponent(0.65)
            let captionFont = UIFont.systemFont(ofSize: 15, weight: .semibold)
            let labelFont = UIFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)

            func text(_ str: String, at point: CGPoint, font: UIFont,
                      color: UIColor = UIColor.white.withAlphaComponent(0.65),
                      centered: Bool = false) {
                let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
                let size = (str as NSString).size(withAttributes: attrs)
                let origin = centered
                    ? CGPoint(x: point.x - size.width / 2, y: point.y - size.height / 2)
                    : point
                (str as NSString).draw(at: origin, withAttributes: attrs)
            }

            // Panel borders + captions.
            for (rect, caption, present, missing) in [
                (faceRect, "You", hasFace, "no face recording"),
                (reelRect, "Reel", hasReel, "no reel recording"),
            ] {
                ctx.setStrokeColor(hairline.cgColor)
                ctx.setLineWidth(1)
                ctx.stroke(rect)
                text(caption, at: CGPoint(x: rect.minX + 10, y: rect.minY + 8), font: captionFont,
                     color: UIColor.white.withAlphaComponent(0.85))
                if !present {
                    text(missing, at: CGPoint(x: rect.midX, y: rect.midY), font: labelFont,
                         centered: true)
                }
            }

            let p = plotRect
            if yRange.lowerBound < 0 {
                // The signed (PC1) graph is wordless: a bare y axis, the zero
                // line as its x axis, and the poles named by faces. The fill
                // says everything else, and its advancing edge tells the time.
                ctx.setStrokeColor(UIColor.white.withAlphaComponent(0.35).cgColor)
                ctx.setLineWidth(1)
                ctx.move(to: CGPoint(x: p.minX, y: p.minY))
                ctx.addLine(to: CGPoint(x: p.minX, y: p.maxY))
                ctx.strokePath()
                ctx.move(to: CGPoint(x: p.minX, y: p.midY))
                ctx.addLine(to: CGPoint(x: p.maxX, y: p.midY))
                ctx.strokePath()
                let face = UIFont.systemFont(ofSize: 22)
                text("🙂", at: CGPoint(x: p.minX, y: p.minY - 16), font: face, centered: true)
                text("🙁", at: CGPoint(x: p.minX, y: p.maxY + 16), font: face, centered: true)
            } else {
                // Named-series fallback: frame, gridlines, y labels.
                ctx.setStrokeColor(hairline.cgColor)
                ctx.setLineWidth(1)
                ctx.stroke(p)
                for v in [0.0, 0.25, 0.5, 0.75, 1.0] {
                    let y = p.minY + p.height * CGFloat(1 - v)
                    let labeled = yRange.lowerBound + v * (yRange.upperBound - yRange.lowerBound)
                    if v != 0 && v != 1 {
                        ctx.setStrokeColor(UIColor.white.withAlphaComponent(0.08).cgColor)
                        ctx.move(to: CGPoint(x: p.minX, y: y))
                        ctx.addLine(to: CGPoint(x: p.maxX, y: y))
                        ctx.strokePath()
                    }
                    text(String(format: "%.2f", labeled), at: CGPoint(x: graphRect.minX + 6, y: y - 8),
                         font: labelFont)
                }

                // X ticks: pick a step that yields <= 8 labels.
                let step = [15.0, 30, 60, 120, 300, 600].first { duration / $0 <= 8 } ?? 600
                var tick = 0.0
                while tick <= duration {
                    let x = p.minX + p.width * CGFloat(tick / duration)
                    ctx.setStrokeColor(hairline.cgColor)
                    ctx.move(to: CGPoint(x: x, y: p.maxY))
                    ctx.addLine(to: CGPoint(x: x, y: p.maxY + 4))
                    ctx.strokePath()
                    let mins = Int(tick) / 60, secs = Int(tick) % 60
                    text(String(format: "%d:%02d", mins, secs),
                         at: CGPoint(x: x, y: p.maxY + 12), font: labelFont, centered: true)
                    tick += step
                }

                // Legend, top-right of the graph area.
                var legendX = p.maxX
                for spec in series.reversed() {
                    let attrs: [NSAttributedString.Key: Any] = [.font: labelFont, .foregroundColor: textColor]
                    let size = (spec.label as NSString).size(withAttributes: attrs)
                    legendX -= size.width
                    (spec.label as NSString).draw(at: CGPoint(x: legendX, y: graphRect.minY + 12),
                                                  withAttributes: attrs)
                    legendX -= 16
                    spec.color.setFill()
                    ctx.fill(CGRect(x: legendX, y: graphRect.minY + 12 + size.height / 2 - 5, width: 10, height: 10))
                    legendX -= 18
                }
                text("Expression · \(Int(speedup))× speed", at: CGPoint(x: p.minX, y: graphRect.minY + 10),
                     font: captionFont, color: UIColor.white.withAlphaComponent(0.85))
            }

            if !hasSamples {
                text("no expression data (requires a TrueDepth front camera)",
                     at: CGPoint(x: p.midX, y: p.midY), font: labelFont, centered: true)
            }
        }
        return image.cgImage!
    }

    // MARK: - Drawing helpers

    /// Blit an image into a context whose CTM is flipped to top-left origin:
    /// un-flip locally so the image comes out right side up.
    private static func drawImage(_ img: CGImage, in rect: CGRect, ctx: CGContext) {
        ctx.saveGState()
        ctx.translateBy(x: rect.minX, y: rect.maxY)
        ctx.scaleBy(x: 1, y: -1)
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: rect.width, height: rect.height))
        ctx.restoreGState()
    }

    private static func drawAspectFill(_ img: CGImage, in rect: CGRect, ctx: CGContext) {
        let iw = CGFloat(img.width), ih = CGFloat(img.height)
        guard iw > 0, ih > 0 else { return }
        let scale = max(rect.width / iw, rect.height / ih)
        let drawRect = CGRect(x: rect.midX - iw * scale / 2, y: rect.midY - ih * scale / 2,
                              width: iw * scale, height: ih * scale)
        ctx.saveGState()
        ctx.clip(to: rect)
        drawImage(img, in: drawRect, ctx: ctx)
        ctx.restoreGState()
    }
}
