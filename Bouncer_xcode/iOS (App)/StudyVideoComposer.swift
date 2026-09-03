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

// nonisolated, or the target's default MainActor isolation puts the whole
// frame loop — decode, draw, encode, and its Thread.sleep backpressure wait —
// on the main thread, freezing the UI for the entire composition. Everything
// here is safe off-main: UIGraphicsImageRenderer / UIColor / UIFont /
// NSString.draw are documented thread-safe, and the AV readers/writer are
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

    private static let series: [Series] = [
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

    // MARK: - Entry point

    /// Compose summary.mp4 for a session folder. `progress` is called with
    /// 0…1 on an arbitrary thread. Returns the output URL.
    static func compose(sessionDir: URL, progress: @escaping (Double) -> Void) async throws -> URL {
        let fm = FileManager.default

        // --- gather inputs ---------------------------------------------------
        let recordings = loadRecordings(sessionDir)
        let t0Ms = loadT0Ms(sessionDir)
            ?? recordings.values.flatMap { $0 }.map(\.startMs).min()
        guard let t0Ms else {
            throw ComposeError(message: "No timeline anchor — nothing was recorded in this session.")
        }

        func makeSources(_ kind: String) async -> SegmentedSource {
            var readers: [SegmentReader] = []
            for seg in recordings[kind] ?? [] {
                let url = sessionDir.appendingPathComponent(seg.file)
                guard fm.fileExists(atPath: url.path) else { continue }
                if let r = await SegmentReader.open(url: url, startS: (seg.startMs - t0Ms) / 1000) {
                    readers.append(r)
                }
            }
            return SegmentedSource(readers: readers.sorted { $0.startS < $1.startS })
        }
        let face = await makeSources("face")
        let reel = await makeSources("screen")
        let samples = loadSamples(sessionDir, t0Ms: t0Ms)

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
            duration: duration,
            hasFace: !face.isEmpty, hasReel: !reel.isEmpty, hasSamples: !samples.isEmpty)
        let graphLayer = makeGraphLayer()
        var strokedUpTo = 0            // samples already stroked into graphLayer
        let ciContext = CIContext(options: [.workingColorSpace: NSNull()])

        // --- frame loop --------------------------------------------------------
        let frameCount = Int(duration * fps)
        for i in 0..<frameCount {
            if Task.isCancelled {
                writer.cancelWriting()
                throw CancellationError()
            }
            let t = Double(i) / fps

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
                strokedUpTo = strokeNewSegments(
                    into: graphLayer, samples: samples, from: strokedUpTo,
                    upTo: t, duration: duration)
                if let graphImg = graphLayer.makeImage() {
                    drawImage(graphImg, in: CGRect(x: 0, y: 0, width: canvasW, height: canvasH), ctx: ctx)
                }
                drawImage(overlay, in: CGRect(x: 0, y: 0, width: canvasW, height: canvasH), ctx: ctx)
                drawPlayhead(at: t, duration: duration, samples: samples, upTo: strokedUpTo, ctx: ctx)
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

    private static func loadSamples(_ dir: URL, t0Ms: Double) -> [Sample] {
        guard let text = try? String(contentsOf: dir.appendingPathComponent("expressions.jsonl"),
                                     encoding: .utf8) else { return [] }
        var samples: [Sample] = []
        for line in text.split(separator: "\n") {
            guard let data = line.data(using: .utf8),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let t = obj["t"] as? Double else { continue }
            samples.append(Sample(
                t: (t - t0Ms) / 1000,
                tracked: (obj["tracked"] as? Bool) ?? false,
                values: series.map { (obj[$0.key] as? Double) ?? 0 }))
        }
        return samples.sorted { $0.t < $1.t }
    }

    // MARK: - Sequential segment readers

    /// One video file positioned on the session timeline. Frames are pulled
    /// sequentially; `image(at:)` returns the latest frame at or before the
    /// requested time (held once the file runs out — snapshots-style).
    private final class SegmentReader {
        let startS: Double
        let endS: Double
        private let transform: CGAffineTransform
        private var reader: AVAssetReader?
        private var output: AVAssetReaderTrackOutput?
        private var pending: (t: Double, buffer: CVPixelBuffer)?
        private var lastImage: CGImage?
        private var lastImageT = -Double.infinity

        private init(startS: Double, endS: Double, transform: CGAffineTransform,
                     reader: AVAssetReader, output: AVAssetReaderTrackOutput) {
            self.startS = startS
            self.endS = endS
            self.transform = transform
            self.reader = reader
            self.output = output
        }

        static func open(url: URL, startS: Double) async -> SegmentReader? {
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
                                 transform: transform, reader: reader, output: output)
        }

        func image(at sessionT: Double, ci: CIContext) -> CGImage? {
            let t = sessionT - startS
            while let output {
                if let p = pending {
                    if p.t <= t {
                        lastImage = convert(p.buffer, ci: ci)
                        lastImageT = p.t
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
            return lastImageT <= t ? lastImage : nil
        }

        func close() {
            reader?.cancelReading()
            reader = nil
            output = nil
            pending = nil
        }

        private func convert(_ buffer: CVPixelBuffer, ci: CIContext) -> CGImage? {
            var img = CIImage(cvPixelBuffer: buffer).transformed(by: transform)
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
    private static func strokeNewSegments(into layer: CGContext, samples: [Sample],
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

    /// Vertical playhead line plus a dot per series at the latest value.
    private static func drawPlayhead(at t: Double, duration: Double, samples: [Sample],
                                     upTo: Int, ctx: CGContext) {
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

    private static func renderStaticOverlay(duration: Double, hasFace: Bool, hasReel: Bool,
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

            // Graph frame, gridlines, y labels.
            let p = plotRect
            ctx.setStrokeColor(hairline.cgColor)
            ctx.setLineWidth(1)
            ctx.stroke(p)
            for v in [0.0, 0.25, 0.5, 0.75, 1.0] {
                let y = p.minY + p.height * CGFloat(1 - v)
                if v != 0 && v != 1 {
                    ctx.setStrokeColor(UIColor.white.withAlphaComponent(0.08).cgColor)
                    ctx.move(to: CGPoint(x: p.minX, y: y))
                    ctx.addLine(to: CGPoint(x: p.maxX, y: y))
                    ctx.strokePath()
                }
                text(String(format: "%.2f", v), at: CGPoint(x: graphRect.minX + 6, y: y - 8),
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
            text("Expression", at: CGPoint(x: p.minX, y: graphRect.minY + 10), font: captionFont,
                 color: UIColor.white.withAlphaComponent(0.85))

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
