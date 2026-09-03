//
//  ScrollStudy.swift
//  iOS (App)
//
//  Self-contained "Instagram scroll study" screen for research sessions,
//  ported from the twitter research repo and extended with expression-graph
//  video generation. Independent of the FilteredWebView pipeline.
//
//  What it does:
//    • Loads Instagram Reels in a WKWebView (login persists across launches).
//    • Injects a dependency-free tracker that emits one JSON event per
//      behavioral signal: reel enter/leave (dwell time, completion %, loops,
//      pauses), swipe gestures (velocity, direction), visibility changes,
//      mute toggles, and a liveness heartbeat.
//    • Records the participant's face with the front TrueDepth camera via
//      ARKit face tracking, which simultaneously yields the face video
//      (face-N.mov) and a 10 Hz stream of expression metrics derived from
//      the 52 ARKit blendshape coefficients (expressions.jsonl). Devices
//      without TrueDepth fall back to a plain front-camera recording
//      (video only, no expression data).
//    • Records what's on screen — the reel being watched — into screen-N.mov
//      via ReplayKit in-app capture (the real composited screen; WKWebView
//      snapshots leave playing video as a grey rectangle), throttled to ~5
//      fps. Webview snapshots remain as the no-ReplayKit fallback.
//    • After a session, "Generate video" composes summary.mp4: the face and
//      the reel side by side, with the expression graph drawing itself
//      below them in sync (see StudyVideoComposer.swift).
//
//  Storage pipeline (designed so data cannot be lost):
//    • Every JS event is posted to native IMMEDIATELY (no batching in the
//      page) via window.webkit.messageHandlers.scrollStudy.
//    • Native appends each event as one line to
//          Documents/ScrollStudy/<sessionId>/events.jsonl
//      through a FileHandle that is fsync'd after every write — a crash, app
//      kill, or dead battery loses at most the event being written.
//    • Face and screen videos are written as fragmented QuickTime files
//      (2-second fragment interval), so they stay playable up to the last
//      fragment even if the app dies mid-recording.
//    • recordings.json maps each video segment to the wall-clock time its
//      first frame was captured, so the composer can align everything on
//      one session timeline.
//    • meta.json records device/app/session metadata (endedAt is best-effort;
//      the last event timestamp in events.jsonl is the authoritative end).
//    • Documents/ is exposed via UIFileSharingEnabled +
//      LSSupportsOpeningDocumentsInPlace, so sessions can be pulled off the
//      device with Finder (cable) or the Files app; the panel also offers a
//      per-session zip share sheet (AirDrop etc.). Nothing leaves the device
//      on its own.
//

import SwiftUI
import WebKit
import AVFoundation
import ARKit
import ReplayKit
internal import Combine

// MARK: - Session recorder (JSONL, crash-safe)

/// Owns one study session: the folder, the append-only events file, and the
/// face / expression / screen capture. All appends are serialized on a queue
/// and fsync'd.
final class StudySessionRecorder: ObservableObject {
    @Published private(set) var isRunning = false
    @Published private(set) var eventCount = 0
    @Published private(set) var sessionId: String?
    @Published private(set) var startedAt: Date?
    @Published private(set) var faceActive = false
    @Published private(set) var reelActive = false
    /// Persisted preference; toggling mid-session starts/stops capture live.
    /// Controls face video + expressions + reel recording together — the
    /// inputs the summary video needs.
    @Published var captureEnabled: Bool {
        didSet {
            UserDefaults.standard.set(captureEnabled, forKey: "scrollStudyCaptureEnabled")
            guard isRunning, captureEnabled != oldValue else { return }
            if captureEnabled { startCaptureSegment() } else { stopCaptureSegment() }
        }
    }
    /// Non-nil shows a blocking alert in the study view (e.g. camera denied).
    @Published var alertMessage: String?

    private var fileHandle: FileHandle?
    private var sessionDir: URL?
    private var seq = 0
    private var captureSegment = 0
    private let io = DispatchQueue(label: "scrollstudy.io")
    private let faceCapture = FaceExpressionCapture()
    private let fallbackFace = FaceRecorder()
    private let reel = ReelRecorder()
    private let screen = ScreenRecorder()
    /// Which recorder produced the running screen segment, so stop() stops
    /// the right one.
    private var screenViaReplayKit = false
    private weak var webView: WKWebView?
    /// recordings.json contents: "face"/"screen" -> [{file, startMs}, ...].
    private var recordings: [String: [[String: Any]]] = [:]

    init() {
        // Default ON — capture is the point of the study screen.
        captureEnabled = (UserDefaults.standard.object(forKey: "scrollStudyCaptureEnabled") as? Bool) ?? true
    }

    static var rootDir: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ScrollStudy", isDirectory: true)
    }

    /// Folder of the running (or just-ended) session.
    var currentSessionDir: URL? { sessionDir }

    // MARK: lifecycle

    func start() {
        guard !isRunning else { return }

        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        let id = df.string(from: Date()) + "_" + String(UUID().uuidString.prefix(4))
        let dir = Self.rootDir.appendingPathComponent(id, isDirectory: true)

        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let eventsURL = dir.appendingPathComponent("events.jsonl")
            FileManager.default.createFile(atPath: eventsURL.path, contents: nil)
            fileHandle = try FileHandle(forWritingTo: eventsURL)
        } catch {
            print("[ScrollStudy] failed to create session dir: \(error)")
            return
        }

        sessionDir = dir
        sessionId = id
        startedAt = Date()
        seq = 0
        eventCount = 0
        captureSegment = 0
        recordings = [:]
        isRunning = true
        UIApplication.shared.isIdleTimerDisabled = true

        writeMeta(endedAt: nil)
        appendNative(type: "session_start", extra: [
            "captureRequested": captureEnabled,
            "faceTrackingSupported": FaceExpressionCapture.isSupported,
        ])

        if captureEnabled { startCaptureSegment() }
    }

    /// The study web view registers itself here so the reel recorder can
    /// snapshot it. Called from makeUIView, which may run before or after
    /// start() — both orders work.
    func attachWebView(_ wv: WKWebView) {
        webView = wv
        // Only the snapshot fallback waits on a webview; the ReplayKit
        // recorder started with the capture segment and records the screen
        // whatever webview is showing.
        if isRunning, captureEnabled, !reelActive, !ScreenRecorder.isAvailable { startReelSegment() }
    }

    // Capture recordings are per-segment files (face-1.mov, screen-1.mov,
    // face-2.mov, ...) so the mid-session toggle can stop and restart without
    // clobbering anything. The composer stitches segments by their startMs.
    private func startCaptureSegment() {
        guard let dir = sessionDir else { return }
        captureSegment += 1
        let n = captureSegment
        let faceURL = dir.appendingPathComponent("face-\(n).mov")

        if FaceExpressionCapture.isSupported {
            faceCapture.start(
                videoURL: faceURL,
                expressionsURL: dir.appendingPathComponent("expressions.jsonl"),
                onStarted: { [weak self] file, startMs in
                    DispatchQueue.main.async {
                        self?.faceActive = true
                        self?.noteRecording(kind: "face", file: file, startMs: startMs)
                        self?.appendNative(type: "face_started", extra: ["file": file, "arkit": true])
                    }
                },
                onFullSample: { [weak self] coefs in
                    // Full 52-coefficient dump every 30s for offline analysis.
                    self?.appendNative(type: "blendshapes", extra: ["coefs": coefs])
                },
                onFailure: { [weak self] detail in
                    DispatchQueue.main.async {
                        self?.faceActive = false
                        self?.appendNative(type: "face_failed", extra: ["detail": detail])
                        self?.alertMessage = "Face capture failed: \(detail). The session continues without face data."
                    }
                }
            )
        } else {
            // No TrueDepth camera: plain video, no expression samples.
            fallbackFace.start(to: faceURL) { [weak self] ok, detail, startMs in
                DispatchQueue.main.async {
                    self?.faceActive = ok
                    if ok, let startMs {
                        self?.noteRecording(kind: "face", file: faceURL.lastPathComponent, startMs: startMs)
                    }
                    self?.appendNative(type: ok ? "face_started" : "face_failed",
                                       extra: ["detail": detail, "file": faceURL.lastPathComponent, "arkit": false])
                }
            }
        }

        startReelSegment()
    }

    private func startReelSegment() {
        guard let dir = sessionDir else { return }
        let screenURL = dir.appendingPathComponent("screen-\(captureSegment).mov")
        let onStarted: (String, Double) -> Void = { [weak self] file, startMs in
            DispatchQueue.main.async {
                self?.reelActive = true
                self?.noteRecording(kind: "screen", file: file, startMs: startMs)
                self?.appendNative(type: "reel_recording_started",
                                   extra: ["file": file, "replaykit": self?.screenViaReplayKit ?? false])
            }
        }
        let onFailure: (String) -> Void = { [weak self] detail in
            DispatchQueue.main.async {
                self?.reelActive = false
                self?.appendNative(type: "reel_recording_failed", extra: ["detail": detail])
            }
        }
        // ReplayKit records the real composited screen — including the media
        // layers WKWebView snapshots leave grey where a reel is playing. The
        // snapshot recorder remains only as the fallback (no ReplayKit, or the
        // user declines the system's record-screen prompt).
        if ScreenRecorder.isAvailable {
            // A decline of the system's record-screen prompt surfaces here as
            // a failure — and stays one. Falling back to webview snapshots
            // would record the screen against an answered "no".
            screenViaReplayKit = true
            screen.start(to: screenURL, onStarted: onStarted, onFailure: onFailure)
        } else if let wv = webView {
            screenViaReplayKit = false
            reel.start(webView: wv, to: screenURL, onStarted: onStarted, onFailure: onFailure)
        }
    }

    private func stopCaptureSegment() {
        if FaceExpressionCapture.isSupported { faceCapture.stop() } else { fallbackFace.stop() }
        if screenViaReplayKit { screen.stop() } else { reel.stop() }
        faceActive = false
        reelActive = false
        appendNative(type: "capture_stopped", extra: [:])
    }

    func stop() {
        guard isRunning else { return }
        if captureEnabled || faceActive || reelActive { stopCaptureSegment() }
        appendNative(type: "session_end", extra: [:])
        writeMeta(endedAt: Date())

        io.sync { [fileHandle] in
            try? fileHandle?.synchronize()
            try? fileHandle?.close()
        }
        fileHandle = nil
        isRunning = false
        UIApplication.shared.isIdleTimerDisabled = false
    }

    // MARK: appends

    /// Append a raw JSON event string that came from the page tracker.
    /// Adds a native sequence number + receive timestamp; if the string is
    /// somehow not valid JSON it is still preserved verbatim under "raw".
    func append(rawJSON: String) {
        guard isRunning else { return }
        seq += 1
        let mySeq = seq
        let rx = Date().timeIntervalSince1970 * 1000

        io.async { [fileHandle] in
            var line: Data?
            if let data = rawJSON.data(using: .utf8),
               var obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                obj["seq"] = mySeq
                obj["rx"] = rx
                line = try? JSONSerialization.data(withJSONObject: obj)
            }
            if line == nil {
                let fallback: [String: Any] = ["seq": mySeq, "rx": rx, "type": "unparseable", "raw": rawJSON]
                line = try? JSONSerialization.data(withJSONObject: fallback)
            }
            guard var out = line else { return }
            out.append(0x0A)
            try? fileHandle?.write(contentsOf: out)
            try? fileHandle?.synchronize()   // fsync per event: cheap at these rates
        }
        DispatchQueue.main.async { self.eventCount = mySeq }
    }

    /// Append an event generated on the native side (lifecycle, camera, ...).
    func appendNative(type: String, extra: [String: Any]) {
        var obj: [String: Any] = ["type": type, "t": Date().timeIntervalSince1970 * 1000, "src": "native"]
        for (k, v) in extra { obj[k] = v }
        if let data = try? JSONSerialization.data(withJSONObject: obj),
           let str = String(data: data, encoding: .utf8) {
            append(rawJSON: str)
        }
    }

    /// Record a started video segment in recordings.json — the composer's map
    /// from file to its position on the session timeline.
    private func noteRecording(kind: String, file: String, startMs: Double) {
        guard let dir = sessionDir else { return }
        recordings[kind, default: []].append(["file": file, "startMs": startMs])
        let snapshot = recordings
        io.async {
            if let data = try? JSONSerialization.data(withJSONObject: snapshot, options: .prettyPrinted) {
                try? data.write(to: dir.appendingPathComponent("recordings.json"))
            }
        }
    }

    private func writeMeta(endedAt: Date?) {
        guard let dir = sessionDir else { return }
        let iso = ISO8601DateFormatter()
        var meta: [String: Any] = [
            "sessionId": sessionId ?? "",
            "startedAt": startedAt.map { iso.string(from: $0) } ?? "",
            "t0Ms": (startedAt?.timeIntervalSince1970 ?? 0) * 1000,
            "captureEnabled": captureEnabled,
            "device": UIDevice.current.model,
            "systemVersion": UIDevice.current.systemVersion,
            "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
            "timezone": TimeZone.current.identifier,
        ]
        if let endedAt { meta["endedAt"] = iso.string(from: endedAt) }
        if let data = try? JSONSerialization.data(withJSONObject: meta, options: .prettyPrinted) {
            try? data.write(to: dir.appendingPathComponent("meta.json"))
        }
    }
}

// MARK: - ARKit face capture (video + expression samples)

/// Runs ARKit face tracking on the TrueDepth camera and produces two outputs
/// at once from the same camera feed:
///   • face-N.mov — the camera frames, ~15 fps, fragmented QuickTime
///   • expressions.jsonl — 10 Hz samples of derived expression metrics
///     (smile / frown / brow raise / jaw open, each 0…1, plus `tracked`)
/// Video presentation timestamps are zero-based; onStarted reports the
/// wall-clock ms of the first frame so the composer can place the segment on
/// the session timeline.
final class FaceExpressionCapture: NSObject, ARSessionDelegate {
    static var isSupported: Bool { ARFaceTrackingConfiguration.isSupported }

    private let session = ARSession()
    private let io = DispatchQueue(label: "scrollstudy.face.io")

    private var writer: AVAssetWriter?
    private var writerInput: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var videoURL: URL?
    private var firstFrameAt: TimeInterval?     // ARFrame.timestamp of first appended frame
    private var lastAppendedT: TimeInterval = -1
    private var expressionsHandle: FileHandle?

    // Updated from ARSession delegate callbacks (main queue by default).
    private var latestCoefs: [String: Double]?
    private var tracked = false
    private var lastSampleAt: TimeInterval = 0
    private var lastFullSampleAt: TimeInterval = 0

    private var onStarted: ((String, Double) -> Void)?
    private var onFullSample: (([String: Double]) -> Void)?
    private var onFailure: ((String) -> Void)?

    private let videoFPS: Double = 15
    private let sampleIntervalS: TimeInterval = 0.1
    private let fullSampleIntervalS: TimeInterval = 30

    func start(videoURL: URL,
               expressionsURL: URL,
               onStarted: @escaping (String, Double) -> Void,
               onFullSample: @escaping ([String: Double]) -> Void,
               onFailure: @escaping (String) -> Void) {
        self.onStarted = onStarted
        self.onFullSample = onFullSample
        self.onFailure = onFailure
        self.videoURL = videoURL
        firstFrameAt = nil
        lastAppendedT = -1
        latestCoefs = nil
        tracked = false

        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            DispatchQueue.main.async {
                guard let self else { return }
                guard granted else { self.onFailure?("camera permission denied"); return }
                self.openExpressionsFile(expressionsURL)
                self.session.delegate = self
                let config = ARFaceTrackingConfiguration()
                config.isLightEstimationEnabled = false
                self.session.run(config, options: [.resetTracking, .removeExistingAnchors])
            }
        }
    }

    func stop() {
        session.pause()
        let writer = writer
        let input = writerInput
        self.writer = nil
        self.writerInput = nil
        self.adaptor = nil
        io.async { [expressionsHandle] in
            try? expressionsHandle?.synchronize()
            try? expressionsHandle?.close()
        }
        expressionsHandle = nil
        if let writer, writer.status == .writing {
            input?.markAsFinished()
            writer.finishWriting { }
        }
    }

    private func openExpressionsFile(_ url: URL) {
        io.async {
            if !FileManager.default.fileExists(atPath: url.path) {
                FileManager.default.createFile(atPath: url.path, contents: nil)
            }
            if let handle = try? FileHandle(forWritingTo: url) {
                _ = try? handle.seekToEnd()
                // async, not sync: recorder.stop() does io.sync from main, so a
                // main.sync here could deadlock. Samples arriving before the
                // handle lands are dropped, which is fine at 10 Hz.
                DispatchQueue.main.async { self.expressionsHandle = handle }
            }
        }
    }

    // MARK: ARSessionDelegate

    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        guard let faceAnchor = anchors.compactMap({ $0 as? ARFaceAnchor }).first else { return }
        tracked = faceAnchor.isTracked
        var coefs: [String: Double] = [:]
        for (location, value) in faceAnchor.blendShapes {
            coefs[location.rawValue] = (value.doubleValue * 10000).rounded() / 10000
        }
        latestCoefs = coefs
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        appendVideoFrame(frame)
        sampleExpressions(frame)
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        onFailure?(error.localizedDescription)
    }

    // MARK: video

    private func appendVideoFrame(_ frame: ARFrame) {
        // Throttle 60 Hz ARKit frames down to ~videoFPS.
        if lastAppendedT >= 0 && frame.timestamp - lastAppendedT < 1.0 / videoFPS { return }

        if writer == nil {
            guard configureWriter(for: frame.capturedImage) else { return }
            firstFrameAt = frame.timestamp
            onStarted?(videoURL?.lastPathComponent ?? "", Date().timeIntervalSince1970 * 1000)
        }
        guard let writer, writer.status == .writing,
              let input = writerInput, input.isReadyForMoreMediaData,
              let adaptor, let first = firstFrameAt else { return }

        let pts = CMTime(seconds: frame.timestamp - first, preferredTimescale: 600)
        if adaptor.append(frame.capturedImage, withPresentationTime: pts) {
            lastAppendedT = frame.timestamp
        }
    }

    private func configureWriter(for pixelBuffer: CVPixelBuffer) -> Bool {
        guard let url = videoURL else { return false }
        do {
            try? FileManager.default.removeItem(at: url)
            let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
            // Fragmented QuickTime: file stays playable up to the last
            // fragment even if the app dies mid-recording.
            writer.movieFragmentInterval = CMTime(seconds: 2, preferredTimescale: 600)

            let w = CVPixelBufferGetWidth(pixelBuffer)
            let h = CVPixelBufferGetHeight(pixelBuffer)
            let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: w,
                AVVideoHeightKey: h,
            ])
            input.expectsMediaDataInRealTime = true
            // ARKit's captured image is sensor-landscape; rotate so the file
            // plays portrait. (Unmirrored, like a saved selfie video.)
            input.transform = CGAffineTransform(rotationAngle: .pi / 2)
            guard writer.canAdd(input) else { return false }
            writer.add(input)

            let adaptor = AVAssetWriterInputPixelBufferAdaptor(
                assetWriterInput: input, sourcePixelBufferAttributes: nil)
            guard writer.startWriting() else {
                onFailure?(writer.error?.localizedDescription ?? "writer failed to start")
                return false
            }
            writer.startSession(atSourceTime: .zero)
            self.writer = writer
            self.writerInput = input
            self.adaptor = adaptor
            return true
        } catch {
            onFailure?("face writer setup failed: \(error.localizedDescription)")
            return false
        }
    }

    // MARK: expression samples

    private func sampleExpressions(_ frame: ARFrame) {
        guard frame.timestamp - lastSampleAt >= sampleIntervalS, let coefs = latestCoefs else { return }
        lastSampleAt = frame.timestamp

        func avg(_ keys: String...) -> Double {
            let vals = keys.compactMap { coefs[$0] }
            return vals.isEmpty ? 0 : vals.reduce(0, +) / Double(vals.count)
        }
        let sample: [String: Any] = [
            "t": Date().timeIntervalSince1970 * 1000,
            "tracked": tracked,
            "smile": round4(avg("mouthSmile_L", "mouthSmile_R", "mouthSmileLeft", "mouthSmileRight")),
            "frown": round4(avg("mouthFrown_L", "mouthFrown_R", "mouthFrownLeft", "mouthFrownRight",
                                "browDown_L", "browDown_R", "browDownLeft", "browDownRight")),
            "surprise": round4(avg("browInnerUp")),
            "jawOpen": round4(avg("jawOpen")),
            // The full blendshape vector, near-zero entries dropped (a key the
            // composer doesn't find reads as 0). This is what compose-time PCA
            // runs on — the named metrics above stay for offline analysis and
            // as the graph's fallback for sessions without coefs.
            "coefs": coefs.filter { $0.value >= 0.001 },
        ]
        io.async { [expressionsHandle] in
            guard let handle = expressionsHandle,
                  var data = try? JSONSerialization.data(withJSONObject: sample) else { return }
            data.append(0x0A)
            try? handle.write(contentsOf: data)
        }

        if frame.timestamp - lastFullSampleAt >= fullSampleIntervalS {
            lastFullSampleAt = frame.timestamp
            onFullSample?(coefs)
        }
    }

    private func round4(_ v: Double) -> Double { (v * 10000).rounded() / 10000 }
}

// MARK: - Face recorder (fallback: front camera, video-only, fragmented .mov)

/// Plain front-camera recording for devices without TrueDepth face tracking.
/// Produces the face video but no expression samples — the summary video's
/// graph area shows "no expression data" for these sessions.
final class FaceRecorder: NSObject, AVCaptureFileOutputRecordingDelegate {
    private let session = AVCaptureSession()
    private let output = AVCaptureMovieFileOutput()
    private let queue = DispatchQueue(label: "scrollstudy.camera")
    /// (ok, detail, startMs of first recorded frame — nil until recording began)
    private var completion: ((Bool, String, Double?) -> Void)?

    func start(to url: URL, completion: @escaping (Bool, String, Double?) -> Void) {
        self.completion = completion
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            guard let self else { return }
            guard granted else { completion(false, "camera permission denied", nil); return }
            self.queue.async {
                do {
                    try self.configure()
                    self.session.startRunning()
                    // Fragmented QuickTime: file stays playable up to the last
                    // fragment even if the app dies mid-recording.
                    self.output.movieFragmentInterval = CMTime(seconds: 2, preferredTimescale: 600)
                    self.output.startRecording(to: url, recordingDelegate: self)
                } catch {
                    completion(false, "camera setup failed: \(error.localizedDescription)", nil)
                }
            }
        }
    }

    func stop() {
        queue.async {
            if self.output.isRecording { self.output.stopRecording() }
            if self.session.isRunning { self.session.stopRunning() }
        }
    }

    private func configure() throws {
        guard session.inputs.isEmpty else { return }   // already configured
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        // Small file, plenty for facial-expression coding.
        session.sessionPreset = session.canSetSessionPreset(.vga640x480) ? .vga640x480 : .medium

        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) else {
            throw NSError(domain: "ScrollStudy", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "no front camera"])
        }
        let input = try AVCaptureDeviceInput(device: camera)
        guard session.canAddInput(input), session.canAddOutput(output) else {
            throw NSError(domain: "ScrollStudy", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "cannot add camera input/output"])
        }
        session.addInput(input)
        session.addOutput(output)
    }

    func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL,
                    from connections: [AVCaptureConnection]) {
        completion?(true, "recording", Date().timeIntervalSince1970 * 1000)
    }

    func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL,
                    from connections: [AVCaptureConnection], error: Error?) {
        if let error { print("[ScrollStudy] face recording finished with error: \(error)") }
    }
}

// MARK: - Screen recorder (ReplayKit -> fragmented .mov)

/// Records what the participant is looking at via ReplayKit's in-app screen
/// capture. Unlike WKWebView snapshots, this is the real composited screen —
/// including the separate media layer a playing reel renders into, which
/// snapshots leave as a grey rectangle. Captures whatever this app shows
/// (only this app; iOS presents a consent prompt on start), throttled to a
/// few fps and written as fragmented QuickTime like every other recording.
/// PTS are zero-based via startSession at the first buffer's timestamp;
/// onStarted reports that frame's wall-clock ms.
final class ScreenRecorder: NSObject {
    static var isAvailable: Bool { RPScreenRecorder.shared().isAvailable }

    private let queue = DispatchQueue(label: "scrollstudy.screen")
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var url: URL?
    private var firstPTS: CMTime?
    private var lastKeptS = -Double.infinity
    private var onStarted: ((String, Double) -> Void)?
    private var onFailure: ((String) -> Void)?
    /// Full-rate buffers arrive (~60/s); keep ~5/s — plenty for "which reel,
    /// at which moment", and it keeps hour-long session files sane.
    private let minFrameGapS = 0.2

    func start(to url: URL,
               onStarted: @escaping (String, Double) -> Void,
               onFailure: @escaping (String) -> Void) {
        self.url = url
        self.onStarted = onStarted
        self.onFailure = onFailure
        self.writer = nil
        self.input = nil
        self.firstPTS = nil
        self.lastKeptS = -.infinity

        let recorder = RPScreenRecorder.shared()
        recorder.isMicrophoneEnabled = false
        recorder.isCameraEnabled = false
        recorder.startCapture(handler: { [weak self] sample, type, error in
            guard error == nil, type == .video, CMSampleBufferIsValid(sample) else { return }
            self?.queue.async { self?.append(sample) }
        }, completionHandler: { [weak self] error in
            if let error {
                DispatchQueue.main.async { self?.onFailure?(error.localizedDescription) }
            }
        })
    }

    func stop(completion: (() -> Void)? = nil) {
        RPScreenRecorder.shared().stopCapture { _ in }
        queue.async { [weak self] in
            guard let self, let writer = self.writer else { completion?(); return }
            self.writer = nil
            let input = self.input
            self.input = nil
            if writer.status == .writing {
                input?.markAsFinished()
                writer.finishWriting { completion?() }
            } else {
                completion?()
            }
        }
    }

    /// Runs on `queue`. Configures the writer from the first buffer, then
    /// appends the sample buffers directly — no pixel copying.
    private func append(_ sample: CMSampleBuffer) {
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        if writer == nil {
            guard configureWriter(from: sample) else { return }
            firstPTS = pts
            DispatchQueue.main.async { [url, onStarted] in
                onStarted?(url?.lastPathComponent ?? "", Date().timeIntervalSince1970 * 1000)
            }
        }
        guard let writer, writer.status == .writing,
              let input, input.isReadyForMoreMediaData else { return }
        let t = pts.seconds
        guard t - lastKeptS >= minFrameGapS else { return }
        if input.append(sample) { lastKeptS = t }
    }

    private func configureWriter(from sample: CMSampleBuffer) -> Bool {
        guard let url, let pixelBuffer = CMSampleBufferGetImageBuffer(sample) else { return false }
        do {
            try? FileManager.default.removeItem(at: url)
            let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
            writer.movieFragmentInterval = CMTime(seconds: 2, preferredTimescale: 600)
            let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: CVPixelBufferGetWidth(pixelBuffer),
                AVVideoHeightKey: CVPixelBufferGetHeight(pixelBuffer),
            ])
            input.expectsMediaDataInRealTime = true
            guard writer.canAdd(input) else { return false }
            writer.add(input)
            guard writer.startWriting() else {
                DispatchQueue.main.async { [onFailure] in
                    onFailure?(writer.error?.localizedDescription ?? "screen writer failed to start")
                }
                return false
            }
            // Zero-base the file's timeline at the first captured frame.
            writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sample))
            self.writer = writer
            self.input = input
            return true
        } catch {
            DispatchQueue.main.async { [onFailure] in
                onFailure?("screen writer setup failed: \(error.localizedDescription)")
            }
            return false
        }
    }
}

// MARK: - Reel recorder (web-view snapshots -> fragmented .mov)

/// Records what the participant is looking at by snapshotting the study web
/// view at ~5 fps and encoding the frames into a fragmented QuickTime movie.
/// 5 fps is choppy as a standalone video but plenty for the summary video's
/// "which reel, at which moment" panel. Presentation timestamps are
/// zero-based; onStarted reports the wall-clock ms of the first frame.
final class ReelRecorder: NSObject {
    private weak var webView: WKWebView?
    private var timer: Timer?
    private let queue = DispatchQueue(label: "scrollstudy.reel")

    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var url: URL?
    private var startMs: Double?
    private var lastPTS: Double = -1
    private var converting = false          // main-thread only: drop frames while busy
    private var onStarted: ((String, Double) -> Void)?
    private var onFailure: ((String) -> Void)?

    private let fps: Double = 5
    private let snapshotWidth: CGFloat = 540

    func start(webView: WKWebView, to url: URL,
               onStarted: @escaping (String, Double) -> Void,
               onFailure: @escaping (String) -> Void) {
        stopTimer()
        self.webView = webView
        self.url = url
        self.onStarted = onStarted
        self.onFailure = onFailure
        self.writer = nil
        self.startMs = nil
        self.lastPTS = -1

        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / fps, repeats: true) { [weak self] _ in
            self?.captureFrame()
        }
    }

    func stop(completion: (() -> Void)? = nil) {
        stopTimer()
        let writer = writer
        let input = input
        self.writer = nil
        self.input = nil
        self.adaptor = nil
        queue.async {
            if let writer, writer.status == .writing {
                input?.markAsFinished()
                writer.finishWriting { completion?() }
            } else {
                completion?()
            }
        }
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    private func captureFrame() {
        guard let webView, webView.bounds.width > 0, !converting else { return }
        let config = WKSnapshotConfiguration()
        config.rect = webView.bounds
        config.snapshotWidth = NSNumber(value: Double(snapshotWidth))
        converting = true
        webView.takeSnapshot(with: config) { [weak self] image, error in
            guard let self else { return }
            guard let cg = image?.cgImage, error == nil else {
                self.converting = false
                return
            }
            let nowMs = Date().timeIntervalSince1970 * 1000
            self.queue.async {
                self.encode(cg, atWallClockMs: nowMs)
                DispatchQueue.main.async { self.converting = false }
            }
        }
    }

    /// Runs on `queue`. Lazily configures the writer from the first frame's
    /// dimensions, then scales every subsequent frame to fill those.
    private func encode(_ cg: CGImage, atWallClockMs nowMs: Double) {
        if writer == nil {
            guard configureWriter(width: cg.width & ~1, height: cg.height & ~1) else { return }
            startMs = nowMs
            DispatchQueue.main.async { [url, onStarted] in
                onStarted?(url?.lastPathComponent ?? "", nowMs)
            }
        }
        guard let writer, writer.status == .writing,
              let input, input.isReadyForMoreMediaData,
              let adaptor, let pool = adaptor.pixelBufferPool,
              let startMs else { return }

        let pts = (nowMs - startMs) / 1000
        guard pts > lastPTS else { return }

        var buffer: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
        guard let buffer else { return }

        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        let w = CVPixelBufferGetWidth(buffer)
        let h = CVPixelBufferGetHeight(buffer)
        guard let ctx = CGContext(
            data: CVPixelBufferGetBaseAddress(buffer),
            width: w, height: h,
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) else { return }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))

        if adaptor.append(buffer, withPresentationTime: CMTime(seconds: pts, preferredTimescale: 600)) {
            lastPTS = pts
        }
    }

    private func configureWriter(width: Int, height: Int) -> Bool {
        guard let url, width > 0, height > 0 else { return false }
        do {
            try? FileManager.default.removeItem(at: url)
            let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
            writer.movieFragmentInterval = CMTime(seconds: 2, preferredTimescale: 600)
            let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
            ])
            input.expectsMediaDataInRealTime = true
            guard writer.canAdd(input) else { return false }
            writer.add(input)
            let adaptor = AVAssetWriterInputPixelBufferAdaptor(
                assetWriterInput: input,
                sourcePixelBufferAttributes: [
                    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                    kCVPixelBufferWidthKey as String: width,
                    kCVPixelBufferHeightKey as String: height,
                ])
            guard writer.startWriting() else {
                DispatchQueue.main.async { [onFailure] in
                    onFailure?(writer.error?.localizedDescription ?? "screen writer failed to start")
                }
                return false
            }
            writer.startSession(atSourceTime: .zero)
            self.writer = writer
            self.input = input
            self.adaptor = adaptor
            return true
        } catch {
            DispatchQueue.main.async { [onFailure] in
                onFailure?("screen writer setup failed: \(error.localizedDescription)")
            }
            return false
        }
    }
}

// MARK: - Web view + tracker

struct StudyWebView: UIViewRepresentable {
    let recorder: StudySessionRecorder

    func makeCoordinator() -> Coordinator { Coordinator(recorder: recorder) }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "scrollStudy")
        controller.addUserScript(WKUserScript(
            source: Self.trackerJS,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))

        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.websiteDataStore = .default()          // persists the IG login
        config.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true
        if #available(iOS 16.4, *) { webView.isInspectable = true }

        if let url = URL(string: "https://www.instagram.com/reels/") {
            webView.load(URLRequest(url: url))
        }
        recorder.attachWebView(webView)
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKScriptMessageHandler {
        let recorder: StudySessionRecorder
        init(recorder: StudySessionRecorder) { self.recorder = recorder }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "scrollStudy", let body = message.body as? String else { return }
            recorder.append(rawJSON: body)
        }
    }

    // Dependency-free tracker. Anchors only on <video> elements + touch events
    // so it survives Instagram's hashed, shifting markup. Every event is posted
    // to native the moment it happens; events while no session is running are
    // dropped on the native side.
    //
    // Event types emitted (all include t = epoch ms):
    //   reel_enter  { key, idx, dir }                       — reel became active
    //   reel_leave  { key, idx, dwellMs, fgMs, durS, maxS,
    //                 playedMs, loops, completion, pauses } — reel left
    //   swipe       { dyPx, dtMs, vPxS, dir }               — one touch gesture
    //   pause/play  { key, atS }                            — user paused/resumed
    //   mute        { key, muted }                          — mute state changed
    //   visibility  { state }                               — page hidden/visible
    //   heartbeat   { activeKey }                           — every 15s (liveness)
    static let trackerJS = """
    (function () {
      if (window.__scrollStudy) return;
      window.__scrollStudy = true;

      var MIN_MS = 200;            // ignore sub-200ms active flickers
      var HEARTBEAT_MS = 15000;

      function post(ev) {
        ev.t = Date.now();
        try { window.webkit.messageHandlers.scrollStudy.postMessage(JSON.stringify(ev)); } catch (e) {}
      }

      // ---- reel identity ----
      var keys = new WeakMap();
      var nextKey = 1;
      function keyOf(v) {
        if (!keys.has(v)) keys.set(v, 'reel-' + (nextKey++));
        return keys.get(v);
      }

      // ---- per-reel watch state ----
      // cur = { v, key, idx, enterT, accumMs, resumeT, playedMs, lastTimeS,
      //         maxS, loops, pauses }
      var cur = null;
      var ratios = new Map();      // video el -> intersection ratio
      var lastIdx = -1;

      function domIndex(v) {
        var vids = document.querySelectorAll('video');
        for (var i = 0; i < vids.length; i++) if (vids[i] === v) return i;
        return -1;
      }

      function accumulate() {
        if (cur && cur.resumeT !== null) {
          cur.accumMs += Date.now() - cur.resumeT;
          cur.resumeT = null;
        }
      }
      function resume() {
        if (cur && cur.resumeT === null && !document.hidden) cur.resumeT = Date.now();
      }

      function onTimeUpdate(e) {
        if (!cur || e.target !== cur.v) return;
        var t = e.target.currentTime || 0;
        var d = t - cur.lastTimeS;
        if (d > 0 && d < 2) cur.playedMs += d * 1000;      // normal forward playback
        else if (d < -1) cur.loops++;                       // wrapped -> looped
        cur.lastTimeS = t;
        if (t > cur.maxS) cur.maxS = t;
      }
      function onPause(e) {
        if (!cur || e.target !== cur.v) return;
        if (document.hidden) return;                        // background pause, not user
        cur.pauses++;
        post({ type: 'pause', key: cur.key, atS: e.target.currentTime || 0 });
      }
      function onPlay(e) {
        if (!cur || e.target !== cur.v) return;
        post({ type: 'play', key: cur.key, atS: e.target.currentTime || 0 });
      }
      function onVolume(e) {
        if (!cur || e.target !== cur.v) return;
        post({ type: 'mute', key: cur.key, muted: !!e.target.muted });
      }

      function leaveCurrent() {
        if (!cur) return;
        accumulate();
        var dwell = Date.now() - cur.enterT;
        var durS = cur.v.duration && isFinite(cur.v.duration) ? cur.v.duration : 0;
        // Completion: fraction of the reel watched at least once (via furthest
        // point reached); loops recorded separately. playedMs covers total
        // playback including rewatches.
        var completion = durS > 0 ? Math.min(1, cur.maxS / durS) : null;
        if (cur.accumMs >= MIN_MS) {
          post({
            type: 'reel_leave', key: cur.key, idx: cur.idx,
            dwellMs: Math.round(dwell), fgMs: Math.round(cur.accumMs),
            durS: Math.round(durS * 100) / 100, maxS: Math.round(cur.maxS * 100) / 100,
            playedMs: Math.round(cur.playedMs), loops: cur.loops,
            completion: completion === null ? null : Math.round(completion * 1000) / 1000,
            pauses: cur.pauses
          });
        }
        cur.v.removeEventListener('timeupdate', onTimeUpdate);
        cur.v.removeEventListener('pause', onPause);
        cur.v.removeEventListener('play', onPlay);
        cur.v.removeEventListener('volumechange', onVolume);
        cur = null;
      }

      function enter(v) {
        var idx = domIndex(v);
        var dir = lastIdx === -1 ? 'start' : (idx >= lastIdx ? 'forward' : 'back');
        lastIdx = idx;
        cur = {
          v: v, key: keyOf(v), idx: idx, enterT: Date.now(), accumMs: 0,
          resumeT: document.hidden ? null : Date.now(),
          playedMs: 0, lastTimeS: v.currentTime || 0, maxS: v.currentTime || 0,
          loops: 0, pauses: 0
        };
        v.addEventListener('timeupdate', onTimeUpdate);
        v.addEventListener('pause', onPause);
        v.addEventListener('play', onPlay);
        v.addEventListener('volumechange', onVolume);
        post({ type: 'reel_enter', key: cur.key, idx: idx, dir: dir });
      }

      // ---- active-reel selection ----
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { ratios.set(en.target, en.intersectionRatio); });
        var best = null, bestR = 0.5;
        ratios.forEach(function (r, v) {
          if (r >= bestR && v.isConnected) { bestR = r; best = v; }
        });
        if (best && (!cur || best !== cur.v)) {
          leaveCurrent();
          enter(best);
        }
      }, { threshold: [0, 0.25, 0.5, 0.75, 1] });

      var seen = new WeakSet();
      function scan() {
        document.querySelectorAll('video').forEach(function (v) {
          if (seen.has(v)) return;
          seen.add(v);
          io.observe(v);
        });
      }
      new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
      scan();

      // ---- swipe gestures ----
      var touch = null;
      document.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) { touch = null; return; }
        touch = { y: e.touches[0].clientY, x: e.touches[0].clientX, t: Date.now() };
      }, { passive: true, capture: true });
      document.addEventListener('touchend', function (e) {
        if (!touch || !e.changedTouches.length) return;
        var dy = e.changedTouches[0].clientY - touch.y;
        var dt = Date.now() - touch.t;
        touch = null;
        if (Math.abs(dy) < 30 || dt <= 0) return;   // taps / micro-moves aren't swipes
        post({
          type: 'swipe', dyPx: Math.round(dy), dtMs: dt,
          vPxS: Math.round(Math.abs(dy) / dt * 1000),
          dir: dy < 0 ? 'next' : 'prev'
        });
      }, { passive: true, capture: true });

      // ---- visibility (backgrounding pauses the foreground clock) ----
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) accumulate(); else resume();
        post({ type: 'visibility', state: document.hidden ? 'hidden' : 'visible' });
      });

      // ---- heartbeat: proves the tracker is alive; gaps are detectable ----
      setInterval(function () {
        post({ type: 'heartbeat', activeKey: cur ? cur.key : null });
      }, HEARTBEAT_MS);

      // ---- flush on page teardown ----
      window.addEventListener('pagehide', leaveCurrent);

      post({ type: 'tracker_ready', ua: navigator.userAgent });
    })();
    """
}

// MARK: - Instrumenting the EXISTING feed web view
//
// The nav-bar study records the user using the app exactly as it is: same
// webview, same filters, same UI. Only two things are added to the feed's
// webview, both inert outside a session: the behavioral tracker script (its
// events are dropped natively unless a session is running) and the
// "scrollStudy" message handler that carries them. The face camera and the
// screen snapshotter attach through StudySessionRecorder as usual.

enum StudyFeedTap {
    /// One handler per instrumented webview, kept so a later session can
    /// re-point it at the live recorder instead of re-adding (a second add of
    /// the same handler name throws, and user scripts have no single-remove).
    private static var handlers: [ObjectIdentifier: Handler] = [:]

    /// Idempotent: safe to call at every session start.
    static func install(on webView: WKWebView, recorder: StudySessionRecorder) {
        let id = ObjectIdentifier(webView)
        if let existing = handlers[id] {
            existing.recorder = recorder
            return
        }
        let handler = Handler(recorder: recorder)
        handlers[id] = handler
        let controller = webView.configuration.userContentController
        controller.add(handler, name: "scrollStudy")
        controller.addUserScript(WKUserScript(
            source: StudyWebView.trackerJS,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
        // The page is already loaded; the user script only covers future
        // navigations. The tracker self-guards on window.__scrollStudy, so
        // running it here too can't double-install.
        webView.evaluateJavaScript(StudyWebView.trackerJS, completionHandler: nil)
    }

    final class Handler: NSObject, WKScriptMessageHandler {
        /// Weak: the content controller retains this handler for the webview's
        /// life, which outlives any one recorder.
        weak var recorder: StudySessionRecorder?
        init(recorder: StudySessionRecorder) { self.recorder = recorder }

        func userContentController(_ controller: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            guard message.name == "scrollStudy", let body = message.body as? String else { return }
            recorder?.append(rawJSON: body)
        }
    }
}

// MARK: - Session export helpers

struct StudySessionInfo: Identifiable {
    let id: String
    let url: URL
    let eventCount: Int
    let hasVideo: Bool
    let summaryURL: URL?      // non-nil once summary.mp4 has been generated
}

enum StudySessions {
    static func list() -> [StudySessionInfo] {
        let fm = FileManager.default
        guard let dirs = try? fm.contentsOfDirectory(at: StudySessionRecorder.rootDir,
                                                     includingPropertiesForKeys: nil) else { return [] }
        return dirs
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .sorted { $0.lastPathComponent > $1.lastPathComponent }
            .map { dir in
                let events = (try? String(contentsOf: dir.appendingPathComponent("events.jsonl"), encoding: .utf8))
                    .map { $0.split(separator: "\n").count } ?? 0
                let names = (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
                let hasVideo = names.contains {
                    ($0.hasPrefix("face") || $0.hasPrefix("screen")) && $0.hasSuffix(".mov")
                }
                let summary = dir.appendingPathComponent("summary.mp4")
                return StudySessionInfo(
                    id: dir.lastPathComponent, url: dir, eventCount: events, hasVideo: hasVideo,
                    summaryURL: fm.fileExists(atPath: summary.path) ? summary : nil)
            }
    }

    /// Zip a session folder (NSFileCoordinator's .forUploading produces a zip)
    /// into tmp and return the zip URL for the share sheet.
    static func zip(_ session: StudySessionInfo) -> URL? {
        var error: NSError?
        var result: URL?
        NSFileCoordinator().coordinate(readingItemAt: session.url, options: .forUploading, error: &error) { zipped in
            let dest = FileManager.default.temporaryDirectory
                .appendingPathComponent("\(session.id).zip")
            try? FileManager.default.removeItem(at: dest)
            if (try? FileManager.default.copyItem(at: zipped, to: dest)) != nil {
                result = dest
            }
        }
        return result
    }
}

// MARK: - Summary-video generation state

/// Drives StudyVideoComposer for one session at a time per session id, and
/// publishes per-session progress so the panel can show it.
@MainActor
final class StudyVideoGenerator: ObservableObject {
    @Published var progress: [String: Double] = [:]    // session id -> 0…1
    @Published var errors: [String: String] = [:]

    func generate(_ session: StudySessionInfo, onDone: @escaping (URL?) -> Void) {
        guard progress[session.id] == nil else { return }
        progress[session.id] = 0
        errors[session.id] = nil
        Task {
            do {
                let url = try await StudyVideoComposer.compose(sessionDir: session.url) { [weak self] p in
                    Task { @MainActor in self?.progress[session.id] = p }
                }
                self.progress[session.id] = nil
                onDone(url)
            } catch {
                self.progress[session.id] = nil
                self.errors[session.id] = error.localizedDescription
                onDone(nil)
            }
        }
    }
}

// MARK: - Screen: web view + floating study button

struct ScrollStudyView: View {
    var onExit: () -> Void

    @StateObject private var recorder = StudySessionRecorder()
    @StateObject private var generator = StudyVideoGenerator()
    @Environment(\.scenePhase) private var scenePhase
    @State private var expanded = false
    @State private var fabOffset = CGSize.zero
    @State private var fabDrag = CGSize.zero
    @State private var sessions: [StudySessionInfo] = []
    @State private var shareURL: URL?
    @State private var now = Date()

    private let clock = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            StudyWebView(recorder: recorder)
                .ignoresSafeArea(edges: .bottom)

            if expanded {
                panel
                    .padding(.trailing, 16)
                    .padding(.bottom, 96)
                    .transition(.scale(scale: 0.85, anchor: .bottomTrailing).combined(with: .opacity))
            }

            fab
                .offset(x: fabOffset.width + fabDrag.width, y: fabOffset.height + fabDrag.height)
                .padding(.trailing, 20)
                .padding(.bottom, 28)
        }
        .onReceive(clock) { now = $0 }
        .onAppear { recorder.start() }         // session runs whenever this screen is open
        .onDisappear { recorder.stop() }       // leaving the screen ends the session
        // Closing / backgrounding the app also ends the session; coming back
        // to the foreground starts a fresh one.
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                recorder.stop()
            case .active:
                if !recorder.isRunning { recorder.start() }
            default:
                break
            }
        }
        .alert("Scroll study", isPresented: Binding(
            get: { recorder.alertMessage != nil },
            set: { if !$0 { recorder.alertMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(recorder.alertMessage ?? "")
        }
    }

    // Floating action button: shows session state at a glance, drag to move.
    private var fab: some View {
        Button {
            withAnimation(.spring(response: 0.3)) {
                expanded.toggle()
                if expanded { sessions = StudySessions.list() }
            }
        } label: {
            ZStack {
                Circle()
                    .fill(recorder.isRunning ? Color.red : Color(red: 234/255, green: 133/255, blue: 84/255))
                    .frame(width: 56, height: 56)
                    .shadow(color: .black.opacity(0.35), radius: 8, y: 3)
                if recorder.isRunning {
                    Text(elapsedString)
                        .font(.system(size: 13, weight: .bold, design: .monospaced))
                        .foregroundColor(.white)
                } else {
                    Image(systemName: "chart.bar.doc.horizontal")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundColor(.white)
                }
            }
        }
        .simultaneousGesture(
            DragGesture()
                .onChanged { fabDrag = $0.translation }
                .onEnded { v in
                    fabOffset.width += v.translation.width
                    fabOffset.height += v.translation.height
                    fabDrag = .zero
                }
        )
    }

    private var elapsedString: String {
        guard let start = recorder.startedAt else { return "0:00" }
        let s = max(0, Int(now.timeIntervalSince(start)))
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    // Expanded control panel. The session itself is automatic (runs while this
    // screen is open) — the panel is for the capture toggle, live counters,
    // generating/sharing past sessions, and leaving the study screen.
    private var panel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Scroll study").font(.headline)
                Spacer()
                // Collapse only — the session keeps running.
                Button {
                    withAnimation(.spring(response: 0.3)) { expanded = false }
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundColor(.secondary)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Label("Session recording · \(recorder.eventCount) events", systemImage: "waveform.path.ecg")
                if recorder.faceActive {
                    Label(FaceExpressionCapture.isSupported
                            ? "Recording face + expressions" : "Recording face (no TrueDepth)",
                          systemImage: "video.fill")
                        .foregroundColor(.red)
                } else if recorder.captureEnabled {
                    Label("Camera starting / unavailable", systemImage: "video.slash").foregroundColor(.orange)
                }
                if recorder.reelActive {
                    Label("Recording reel", systemImage: "record.circle").foregroundColor(.red)
                }
            }
            .font(.subheadline)

            Toggle(isOn: $recorder.captureEnabled) {
                Label("Capture face + reel (for summary video)", systemImage: "video")
                    .font(.subheadline)
            }

            let pastSessions = sessions.filter { $0.id != recorder.sessionId }
            if !pastSessions.isEmpty {
                Divider()
                Text("Past sessions on device").font(.caption).foregroundColor(.secondary)
                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(pastSessions) { s in
                            sessionRow(s)
                        }
                    }
                }
                .frame(maxHeight: 180)
                Text("Also in Files app → Bouncer → ScrollStudy")
                    .font(.caption2).foregroundColor(.secondary)
            }

            Divider()
            // Leaving the screen is what ends the session (see onDisappear).
            Button {
                onExit()
            } label: {
                Label("Exit study (ends session)", systemImage: "rectangle.portrait.and.arrow.right")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
        }
        .padding(14)
        .frame(width: 300)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.25), radius: 12, y: 4)
        .sheet(item: Binding(
            get: { shareURL.map { ShareItem(url: $0) } },
            set: { shareURL = $0?.url }
        )) { item in
            ShareSheet(url: item.url)
        }
    }

    @ViewBuilder
    private func sessionRow(_ s: StudySessionInfo) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 1) {
                Text(s.id).font(.caption2.monospaced()).lineLimit(1)
                Text("\(s.eventCount) events\(s.hasVideo ? " · video" : "")")
                    .font(.caption2).foregroundColor(.secondary)
                if let err = generator.errors[s.id] {
                    Text(err).font(.caption2).foregroundColor(.red).lineLimit(2)
                }
            }
            Spacer()
            if let p = generator.progress[s.id] {
                Text("\(Int(p * 100))%")
                    .font(.caption2.monospacedDigit())
                    .foregroundColor(.secondary)
            } else if let summary = s.summaryURL {
                // Summary already generated — share it directly.
                Button { shareURL = summary } label: {
                    Image(systemName: "play.rectangle.fill")
                }
            } else if s.hasVideo {
                // Compose face + reel + expression graph into summary.mp4.
                Button {
                    generator.generate(s) { url in
                        sessions = StudySessions.list()
                        if let url { shareURL = url }
                    }
                } label: {
                    Image(systemName: "film")
                }
            }
            Button {
                shareURL = StudySessions.zip(s)
            } label: {
                Image(systemName: "square.and.arrow.up")
            }
        }
    }
}

// Shared with the nav-bar study flow in FilterPhraseSheet.swift.
struct ShareItem: Identifiable {
    let url: URL
    var id: String { url.path }
}

struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
