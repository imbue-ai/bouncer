//
//  LocalInferenceService.swift
//  iOS (App)
//
//  On-device LLM inference: chat filtering (pipe-delimited yes/no verdicts)
//  + AI-text detection (4-class classifier head on chat-decode logits).
//
//  Architecture: single chat engine over upstream Gemma 4 E4B IT
//  (litert-community/gemma-4-E4B-it-litert-lm). The Swift-side LinearV3Head
//  reads getAuxiliaryOutput("logits") and projects to 4 classes via Accelerate.
//

import Foundation
internal import Combine
import LiteRTLM
import Accelerate

/// Linear classification head (v3): LayerNorm(V) -> Linear(V, 4).
/// Trained on Gemma 4 E4B IT last-token logits (V=262144). Used in Swift to
/// post-process chat logits emitted via getAuxiliaryOutput("logits").
///
/// Binary layout of bundled `linear_v3_head.bin` (all little-endian):
///   magic    4 bytes  ASCII "LV1H"
///   v_dim    u32      = 262144
///   n_class  u32      = 4
///   gamma    fp32[v_dim]                LayerNorm.weight
///   beta     fp32[v_dim]                LayerNorm.bias
///   W        fp32[n_class * v_dim]      Linear.weight  (row-major [n_class, v_dim])
///   b        fp32[n_class]              Linear.bias
final class LinearV3Head {
    let vDim: Int
    let nClass: Int
    private let gamma: [Float]   // [V]
    private let beta: [Float]    // [V]
    private let weight: [Float]  // [n_class, V] row-major
    private let bias: [Float]    // [n_class]

    enum LoadError: Error { case fileNotFound, badMagic, badShape, truncated }

    init(bundledFilename: String = "linear_v3_head") throws {
        guard let url = Bundle.main.url(forResource: bundledFilename, withExtension: "bin") else {
            throw LoadError.fileNotFound
        }
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        if data.count < 12 { throw LoadError.truncated }
        let magic = data.prefix(4)
        if magic != Data([0x4C, 0x56, 0x31, 0x48]) { throw LoadError.badMagic }   // "LV1H"
        let vDim = data.withUnsafeBytes { $0.load(fromByteOffset: 4, as: UInt32.self) }
        let nClass = data.withUnsafeBytes { $0.load(fromByteOffset: 8, as: UInt32.self) }
        if vDim == 0 || nClass == 0 { throw LoadError.badShape }
        self.vDim = Int(vDim)
        self.nClass = Int(nClass)

        let v = self.vDim
        let n = self.nClass
        let expected = 12 + (v * 2 + v * n + n) * 4
        if data.count < expected { throw LoadError.truncated }

        // Slices: 12 .. 12+4v (gamma), 12+4v .. 12+8v (beta), 12+8v .. 12+8v+4*n*v (W), 12+8v+4*n*v .. (b)
        func readFloats(_ offset: Int, _ count: Int) -> [Float] {
            return data.withUnsafeBytes { raw in
                let p = raw.baseAddress!.advanced(by: offset).assumingMemoryBound(to: Float.self)
                return Array(UnsafeBufferPointer(start: p, count: count))
            }
        }
        var off = 12
        self.gamma = readFloats(off, v);              off += v * 4
        self.beta  = readFloats(off, v);              off += v * 4
        self.weight = readFloats(off, n * v);         off += n * v * 4
        self.bias  = readFloats(off, n)
    }

    /// Apply LayerNorm + Linear in fp32 using Accelerate. Returns `nClass` floats.
    /// Caller is responsible for converting fp16 input to fp32.
    func forward(_ logits: [Float]) -> [Float] {
        precondition(logits.count == vDim, "input dim mismatch: got \(logits.count), expected \(vDim)")

        // --- LayerNorm: mean & variance over the V-dim ---
        var mean: Float = 0
        var meanSq: Float = 0
        logits.withUnsafeBufferPointer { p in
            vDSP_meanv(p.baseAddress!, 1, &mean, vDSP_Length(vDim))
            vDSP_measqv(p.baseAddress!, 1, &meanSq, vDSP_Length(vDim))
        }
        let variance = meanSq - mean * mean
        let eps: Float = 1e-5
        let invStd: Float = 1.0 / sqrt(variance + eps)

        // x' = (x - mean) * invStd * gamma + beta
        // Compute into a scratch buffer.
        var xn = [Float](repeating: 0, count: vDim)
        var negMean = -mean
        logits.withUnsafeBufferPointer { lp in
            xn.withUnsafeMutableBufferPointer { xp in
                vDSP_vsadd(lp.baseAddress!, 1, &negMean, xp.baseAddress!, 1, vDSP_Length(vDim))
            }
        }
        var scale = invStd
        xn.withUnsafeMutableBufferPointer { xp in
            vDSP_vsmul(xp.baseAddress!, 1, &scale, xp.baseAddress!, 1, vDSP_Length(vDim))
        }
        // multiply by gamma, add beta
        gamma.withUnsafeBufferPointer { gp in
            xn.withUnsafeMutableBufferPointer { xp in
                vDSP_vmul(xp.baseAddress!, 1, gp.baseAddress!, 1, xp.baseAddress!, 1, vDSP_Length(vDim))
            }
        }
        beta.withUnsafeBufferPointer { bp in
            xn.withUnsafeMutableBufferPointer { xp in
                vDSP_vadd(xp.baseAddress!, 1, bp.baseAddress!, 1, xp.baseAddress!, 1, vDSP_Length(vDim))
            }
        }

        // --- Linear: y = W @ x' + b. W is [n_class, V] row-major.
        // Use BLAS sgemv: y = alpha * A^T * x + beta * y, with A laid out as
        // [V, n_class] in column-major == [n_class, V] in row-major.
        // Simpler: just sgemv with row-major via cblas_sgemv.
        var y = bias  // start from bias, accumulate W @ x'
        weight.withUnsafeBufferPointer { wp in
            xn.withUnsafeBufferPointer { xp in
                y.withUnsafeMutableBufferPointer { yp in
                    cblas_sgemv(
                        CblasRowMajor, CblasNoTrans,
                        Int32(nClass), Int32(vDim),
                        1.0,
                        wp.baseAddress!, Int32(vDim),
                        xp.baseAddress!, 1,
                        1.0,
                        yp.baseAddress!, 1
                    )
                }
            }
        }
        return y
    }
}

@MainActor
final class LocalInferenceService: ObservableObject {

    static let shared = LocalInferenceService()

    enum ModelStatus: Equatable {
        case notDownloaded
        case downloading(progress: Double)
        case paused(progress: Double)
        case downloaded
        case loading
        case ready
        case error(String)
    }

    @Published private(set) var modelStatus: ModelStatus = .notDownloaded
    @Published private(set) var downloadedBytesDisplay: String = ""
    @Published private(set) var totalBytesDisplay: String = ""

    // Upstream Gemma 4 E4B IT — single chat signature. The classification
    // head (4-class linear probe over the 262144 vocab logits) runs in Swift
    // on the chat decode "logits" aux output, so no per-model classifier
    // signature is needed.
    private static let modelURL = URL(string:
        // TEMPORARILY unpinned to test whether the format-drift on iOS is
        // tied to the older 9695417f2481 revision's tokenizer/stop-tokens
        // metadata. The pinning comment claimed `main` adds MTP / verify
        // speculative-decoding subgraphs that fail Metal compile with
        // status 504 — if that's still true, engine create will fail on
        // first launch and we revert to the pin. If it loads, we keep
        // the unpinned URL for upstream metadata improvements.
        "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it.litertlm"
    )!

    private let downloader: ModelDownloader
    // Single chat engine over the upstream Gemma .litertlm. The Swift-side
    // LinearV3Head consumes the chat logits via getAuxiliaryOutput("logits")
    // for AI-text classification.
    private var engine: Engine?
    private var classifierHead: LinearV3Head?
    private var loadTask: Task<Void, Error>?
    private var statusPollTimer: Timer?

    private var samplerConfig: SamplerConfig?

    private var baseConversation: Conversation?
    private var baseSystemMessage: String?
    private var baseRegexConstraint: String?

    private let inferenceQueue = AsyncSerialQueue()
    private init() {
        // Background-session singleton: AppDelegate forwards relaunch
        // events through ModelDownloader.shared, so this service must use
        // the same instance.
        self.downloader = ModelDownloader.shared
        refreshStatusFromDisk()
        observeDownloader()
        // Pick up any download iOS continued while the app was suspended
        // or killed; also reflect persisted resume data into the UI.
        Task { await self.downloader.reconcileWithSession() }
    }

    // MARK: - Public API

    func classify(systemMessage: String, userMessage: String, imageUrls: [String] = [], regexConstraint: String? = nil) async throws -> String {
        return try await classifyInternal(
            tag: "Filter", systemMessage: systemMessage,
            userMessage: userMessage, imageUrls: imageUrls,
            regexConstraint: regexConstraint)
    }

    /// Run the full inference path: image fetch → queue → base build/clone
    /// → sendMessage → response. `tag` is the log prefix (e.g. "Filter" for
    /// production calls).
    private func classifyInternal(
        tag: String, systemMessage: String, userMessage: String, imageUrls: [String] = [],
        regexConstraint: String? = nil
    ) async throws -> String {
        try await ensureReady()
        let wallStart = Date()
        let fetchStart = Date()
        let imageData = await Self.fetchImageData(imageUrls)
        let fetchSec = Date().timeIntervalSince(fetchStart)
        let preFetchEnd = Date()
        let contents: [Content] = imageData.map(Content.imageData) + [.text(userMessage)]

        return try await inferenceQueue.run { [weak self] in
            let queueSec = Date().timeIntervalSince(preFetchEnd)
            guard let self else { throw LocalInferenceError.engineNotLoaded }

            func attempt() async throws -> (String, Double, Double, Double, Bool) {
                guard let engine = await self.engine,
                      let sampler = await self.samplerConfig
                else { throw LocalInferenceError.engineNotLoaded }
                let baseStart = Date()
                let (base, rebuiltBase) = try await self.getOrBuildBase(
                    systemMessage: systemMessage, regexConstraint: regexConstraint,
                    sampler: sampler, engine: engine)
                let baseSec = Date().timeIntervalSince(baseStart)
                let cloneStart = Date()
                let convo = try base.clone()
                let cloneSec = Date().timeIntervalSince(cloneStart)
                let inferStart = Date()
                let response = try await convo.sendMessage(
                    Message(contents: contents, role: .user))
                let inferSec = Date().timeIntervalSince(inferStart)
                return (response.toString, baseSec, cloneSec, inferSec, rebuiltBase)
            }

            do {
                let (raw, baseSec, cloneSec, inferSec, rebuiltBase) = try await attempt()
                let wallSec = Date().timeIntervalSince(wallStart)
                print(String(
                    format: "[%@] wall=%.2fs (queue=%.2fs fetch=%.2fs base=%.2fs(%@) clone=%.2fs infer=%.2fs) imgs=%d",
                    tag, wallSec, queueSec, fetchSec, baseSec, rebuiltBase ? "rebuilt" : "cached",
                    cloneSec, inferSec, imageData.count
                ))
                print("[\(tag)] system:\n\(systemMessage)")
                print("[\(tag)] user:\n\(userMessage)")
                print("[\(tag)] raw: \(raw)")
                return raw
            } catch {
                let msg = error.localizedDescription
                let isTransient = msg.contains("sendMessage returned null")
                    || msg.contains("Failed to invoke the compiled model")
                    || msg.contains("Failed to create conversation")
                    || msg.contains("Failed to clone the conversation")
                    || msg.contains("Execution manager is not available")
                let wallSec = Date().timeIntervalSince(wallStart)
                print(String(
                    format: "[%@] FAIL wall=%.2fs imgs=%d err=%@ transient=%@",
                    tag, wallSec, imageData.count, msg, isTransient ? "yes" : "no"
                ))
                print("[\(tag)] system:\n\(systemMessage)")
                print("[\(tag)] user:\n\(userMessage)")
                guard isTransient else { throw error }
                print("[\(tag)] RETRY rebuild-engine")
                try await self.rebuildEngine()
                let (raw, baseSec, cloneSec, inferSec, rebuiltBase) = try await attempt()
                let wallSec2 = Date().timeIntervalSince(wallStart)
                print(String(
                    format: "[%@] resp(retry) wall=%.2fs (base=%.2fs(%@) clone=%.2fs infer=%.2fs)",
                    tag, wallSec2, baseSec, rebuiltBase ? "rebuilt" : "cached", cloneSec, inferSec
                ))
                print("[\(tag)] raw(retry): \(raw)")
                await self.dropBaseConversation()
                return raw
            }
        }
    }

    private func getOrBuildBase(
        systemMessage: String, regexConstraint: String?,
        sampler: SamplerConfig, engine: Engine
    ) async throws -> (Conversation, Bool) {
        if let base = self.baseConversation,
           self.baseSystemMessage == systemMessage,
           self.baseRegexConstraint == regexConstraint,
           base.isAlive {
            return (base, false)
        }
        // Verdicts are pipe-delimited yes/no rows (e.g. "no|no", "yes|yes").
        // With the regex constraint enabled, Gemma also burns tokens on
        // optional whitespace cells in the regex — pad max_output_tokens to
        // 24 so a 4-category pack has slack for delimiter+space tokenization
        // variation. Without the constraint the unconstrained budget would
        // still cap chat decode time vs the old 32-token default.
        let config = ConversationConfig(
            systemMessage: Message(systemMessage, role: .system),
            samplerConfig: sampler,
            prefillPrefaceOnInit: true,
            maxOutputTokens: 24,
            regexConstraint: regexConstraint
        )
        let base = try await engine.createConversation(with: config)
        self.baseConversation = base
        self.baseSystemMessage = systemMessage
        self.baseRegexConstraint = regexConstraint
        return (base, true)
    }

    private func dropBaseConversation() {
        self.baseConversation = nil
        self.baseSystemMessage = nil
        self.baseRegexConstraint = nil
    }

    private static func fetchImageData(_ urls: [String]) async -> [Data] {
        guard !urls.isEmpty else { return [] }
        return await withTaskGroup(of: (Int, Data?).self) { group in
            for (idx, urlString) in urls.enumerated() {
                group.addTask {
                    guard let url = URL(string: urlString) else { return (idx, nil) }
                    let data = try? await URLSession.shared.data(from: url).0
                    return (idx, data)
                }
            }
            var results: [(Int, Data)] = []
            for await (idx, data) in group {
                if let data { results.append((idx, data)) }
            }
            return results.sorted(by: { $0.0 < $1.0 }).map(\.1)
        }
    }

    // Run AI-text classification: prefill the raw text on the chat engine
    // (no chat template), trigger a 1-token decode to populate the chat
    // "logits" aux output (262144 fp16), then apply the Swift-side
    // LinearV3Head (LayerNorm + Linear) to produce 4-class logits.
    func classifyText(_ text: String) async throws -> [Float] {
        try await ensureReady()
        return try await classifyTextInternal(text)
    }

    /// Mirror of `scripts/preprocess.py::clean_text()` minus emoji demojize /
    /// think-tag / ai-header (those rarely apply to tweets). Critical for
    /// matching the token IDs the classifier head was trained on: training
    /// cached logits AFTER lowercasing + whitespace normalization. If iOS
    /// sends raw text instead, "Every" → 13111 but training saw "every" →
    /// 27881, so the model's last-token logits don't match the head's
    /// learned features.
    private static func cleanTextForClassifier(_ text: String) -> String {
        let lowered = text.lowercased()
        // \s+ -> single space, then trim
        let parts = lowered.split(whereSeparator: { $0.isWhitespace })
        return parts.joined(separator: " ")
    }

    private func classifyTextInternal(_ rawText: String) async throws -> [Float] {
        let text = Self.cleanTextForClassifier(rawText)
        guard let engine = self.engine,
              let sampler = self.samplerConfig,
              let head = self.classifierHead else {
            throw LocalInferenceError.engineNotLoaded
        }
        // Revert to maxOutputTokens=1: maxOutputTokens=0 was confirmed to
        // produce stale/garbage logits in the buffer. With =1 the runtime
        // does prefill + 1 decode step. The "logits" aux is the DECODE
        // logits (at position N, predicting token N+1) — not the
        // post-prefill ones training expects. Diagnostic still printed.
        let cfg = ConversationConfig(
            samplerConfig: sampler,
            prefillPrefaceOnInit: false,
            maxOutputTokens: 1,
            skipChatTemplate: true
        )
        let t0 = Date()
        let conv = try await engine.createConversation(with: cfg)
        let tCreate = Date()
        var sendErr: Error? = nil
        do {
            _ = try await conv.sendMessage(Message(text, role: .user))
        } catch {
            sendErr = error
        }
        let tSend = Date()
        // Read full chat-vocab logits (262144 fp32 widened from fp16 in the runtime).
        let chatLogits: [Float]
        do {
            chatLogits = try conv.getAuxiliaryOutput(name: "logits")
        } catch let auxErr {
            print("[Classify] aux read failed: \(auxErr.localizedDescription)  sendErr: \(sendErr.map { $0.localizedDescription } ?? "none")")
            if let sendErr = sendErr { throw sendErr }
            throw auxErr
        }
        let tAux = Date()
        // The decode signature may return logits flattened over [B, T_decode, V].
        // We always want the LAST T's logits (length V). If oversize, slice.
        let v = head.vDim
        let last: [Float]
        if chatLogits.count == v {
            last = chatLogits
        } else if chatLogits.count > v && chatLogits.count % v == 0 {
            last = Array(chatLogits.suffix(v))
        } else {
            throw LocalInferenceError.engineNotLoaded
        }
        let headOut = head.forward(last)
        let tHead = Date()
        let msCreate = Int((tCreate.timeIntervalSince(t0)) * 1000)
        let msSend = Int((tSend.timeIntervalSince(tCreate)) * 1000)
        let msAux = Int((tAux.timeIntervalSince(tSend)) * 1000)
        let msHead = Int((tHead.timeIntervalSince(tAux)) * 1000)
        let msTotal = Int((tHead.timeIntervalSince(t0)) * 1000)
        print("[Classify timing] total=\(msTotal)ms create=\(msCreate)ms send=\(msSend)ms aux=\(msAux)ms head=\(msHead)ms sendErr=\(sendErr != nil)")
        return headOut
    }

    /// Normalized expected bucket index over the softmax of the 4-class
    /// classifier head's logits — matches the EditLens training-pipeline
    /// scoring formula `(probs @ arange(n_buckets)) / (n_buckets - 1)`.
    /// For n=4: `(0·p0 + 1·p1 + 2·p2 + 3·p3) / 3`. Range [0, 1] where
    /// 0 = all mass on class 0 (clearly human), 1 = all mass on class 3
    /// (clearly AI). Continuous interpolation between buckets — not the
    /// discrete `P(class>=2)` reduction.
    nonisolated static func aiConfidence(fromLogits logits: [Float]) -> Float {
        guard !logits.isEmpty else { return 0 }
        let m = logits.max() ?? 0
        let exps = logits.map { exp($0 - m) }
        let z = exps.reduce(0, +)
        guard z > 0 else { return 0 }
        let probs = exps.map { $0 / z }
        let n = probs.count
        guard n >= 2 else { return 0 }
        var expectation: Float = 0
        for (i, p) in probs.enumerated() { expectation += Float(i) * p }
        return expectation / Float(n - 1)
    }

    func ensureReady() async throws {
        if engine != nil, modelStatus == .ready { return }
        guard downloader.isDownloaded else {
            throw LocalInferenceError.modelNotDownloaded
        }
        if let loadTask = loadTask {
            try await loadTask.value
            return
        }
        modelStatus = .loading
        let task = Task<Void, Error> { [weak self] in
            guard let self else { return }
            let cacheDir = self.engineCacheDir()
            try? FileManager.default.createDirectory(
                at: cacheDir, withIntermediateDirectories: true)
            let engine = try await self.buildEngine(cacheDir: cacheDir)
            let sampler = try SamplerConfig(topK: 1, topP: 1.0, temperature: 1.0)
            // Load the bundled classifier head once at engine-ready time.
            // 6.29 MB blob; takes a few ms to read + parse.
            let head: LinearV3Head
            do {
                head = try LinearV3Head()
                print("[Head] loaded linear_v3 head v_dim=\(head.vDim) n_class=\(head.nClass)")
            } catch {
                print("[Head] FAILED to load linear_v3_head.bin: \(error)")
                throw error
            }
            await MainActor.run {
                self.engine = engine
                self.samplerConfig = sampler
                self.classifierHead = head
                self.modelStatus = .ready
            }
        }
        loadTask = task
        do {
            try await task.value
        } catch {
            loadTask = nil
            modelStatus = .error("Load failed: \(error.localizedDescription)")
            throw error
        }
        loadTask = nil
    }

    private func engineCacheDir() -> URL {
        let cacheRoot = FileManager.default
            .urls(for: .cachesDirectory, in: .userDomainMask)[0]
        // New cache dir so we don't reuse the dual-sig bouncer compile artifacts.
        return cacheRoot.appendingPathComponent("litertlm_cache/upstream_v1", isDirectory: true)
    }

    private func buildEngine(cacheDir: URL) async throws -> Engine {
        // Upstream Gemma 4 E4B IT — single chat signature pair. Don't pin
        // decodeSignatureName / prefillSignatureFilter; the runtime will pick
        // the standard "decode" + "prefill_*" signatures bundled in the file.
        let cfg = try EngineConfig(
            modelPath: self.downloader.modelPath.path,
            backend: .gpu,
            visionBackend: .cpu(),
            maxNumTokens: 1024,
            cacheDir: cacheDir.path
        )
        let engine = Engine(engineConfig: cfg)
        try await engine.initialize()
        return engine
    }

    func rebuildEngine() async throws {
        print("[Filter] REBUILD engine begin")
        let started = Date()
        self.baseConversation = nil
        self.baseSystemMessage = nil
        self.engine = nil
        let cacheDir = engineCacheDir()
        let newEngine = try await buildEngine(cacheDir: cacheDir)
        self.engine = newEngine
        print(String(format: "[Filter] REBUILD engine done in %.2fs",
                     Date().timeIntervalSince(started)))
    }

    func startDownload() {
        if case .downloading = downloader.status { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.downloader.download(from: Self.modelURL)
            } catch is CancellationError {
                // User-initiated pause/cancel — not a failure. The
                // downloader's own status (.paused or .notStarted) is
                // already authoritative; the 0.5s status timer will
                // pick it up. Mirroring it here would race the timer
                // and briefly flash "Download failed" in the UI.
            } catch {
                await MainActor.run {
                    self.modelStatus = .error("Download failed: \(error.localizedDescription)")
                }
            }
        }
    }

    func pauseDownload() {
        downloader.pause()
    }

    // Reconcile with the background URLSession — call from app foreground
    // and from settings-view onAppear so UI matches whatever iOS did
    // while we were suspended.
    func reconcileDownload() {
        Task { await downloader.reconcileWithSession() }
    }

    func cancelDownload() {
        downloader.cancel()
        refreshStatusFromDisk()
    }

    func deleteModel() {
        unloadEngine()
        downloader.deleteModel()
        let cacheRoot = FileManager.default
            .urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let litertCacheDir = cacheRoot.appendingPathComponent(
            "litertlm_cache", isDirectory: true)
        try? FileManager.default.removeItem(at: litertCacheDir)
        refreshStatusFromDisk()
    }

    func unloadEngine() {
        baseConversation = nil
        baseSystemMessage = nil
        engine = nil
        classifierHead = nil
        samplerConfig = nil
        if downloader.isDownloaded {
            modelStatus = .downloaded
        }
    }

    // MARK: - Internal

    private func observeDownloader() {
        statusPollTimer?.invalidate()
        statusPollTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.refreshStatusFromDownloader()
            }
        }
    }

    private func refreshStatusFromDisk() {
        if downloader.isDownloaded {
            modelStatus = engine == nil ? .downloaded : .ready
        } else {
            modelStatus = .notDownloaded
        }
        downloadedBytesDisplay = downloader.downloadedBytesDisplay
        totalBytesDisplay = downloader.totalBytesDisplay
    }

    private func refreshStatusFromDownloader() {
        downloadedBytesDisplay = downloader.downloadedBytesDisplay
        totalBytesDisplay = downloader.totalBytesDisplay

        switch downloader.status {
        case .downloading(let progress):
            modelStatus = .downloading(progress: progress)
        case .paused(let progress):
            modelStatus = .paused(progress: progress)
        case .completed:
            if engine == nil {
                modelStatus = .downloaded
            }
        case .failed(let message):
            modelStatus = .error(message)
        case .notStarted:
            if downloader.isDownloaded {
                modelStatus = engine == nil ? .downloaded : .ready
            } else {
                modelStatus = .notDownloaded
            }
        }
    }
}

enum LocalInferenceError: LocalizedError {
    case modelNotDownloaded
    case engineNotLoaded

    var errorDescription: String? {
        switch self {
        case .modelNotDownloaded:
            return "Local model has not been downloaded yet."
        case .engineNotLoaded:
            return "Local inference engine is not loaded."
        }
    }
}

actor AsyncSerialQueue {
    private var tail: Task<Void, Never>?

    func run<T>(_ work: @Sendable @escaping () async throws -> T) async throws -> T {
        let predecessor = tail
        let task = Task<T, Error> {
            _ = await predecessor?.value
            return try await work()
        }
        tail = Task { _ = try? await task.value }
        return try await task.value
    }
}
