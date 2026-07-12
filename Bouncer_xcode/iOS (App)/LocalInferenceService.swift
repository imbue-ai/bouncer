//
//  LocalInferenceService.swift
//  iOS (App)
//
//  On-device LLM inference: chat filtering (pipe-delimited yes/no verdicts)
//  + AI-text detection (LoRA-conditioned activations + classifier head).
//
//  Architecture: the model registry (`models`) drives everything. Each entry is
//  a LoRA-socketed Gemma .litertlm; the CHAT engine runs it with zero LoRA
//  (numerically the base model) for phrase filtering, and a DEDICATED detection
//  engine scopes the LoRA adapter per conversation and reads the `activations`
//  aux output into a bundled Accelerate classifier head (DetectorHead).
//

import Foundation
internal import Combine
import LiteRTLM
import Accelerate

/// Detector classification head: reads the base bundle's
/// `activations` output ([2560] post-final-norm hidden state) and projects to
/// 4 class logits via `LayerNorm → Linear(2560→2560) → GELU → Linear(2560→4)`.
///
/// This is the off-graph half of the detector (doc §1 `head.tflite`, ~26 MB).
/// We do NOT run head.tflite at runtime — instead a build-time conversion step
/// extracts its 5 weight tensors into a compact bundled blob so we avoid adding
/// a TFLite-Swift dependency. The forward pass runs in Accelerate (vDSP/BLAS).
///
/// Binary layout of the bundled blob (all little-endian). Two variants,
/// distinguished by magic (both produced by scripts/convert_detector_head.py
/// and numerically validated against the source head.tflite):
///
///   DH01 (E4B MLP head): LayerNorm → Linear(H→H) → GELU → Linear(H→4)
///     magic "DH01", hidden u32, n_class u32,
///     ln_gamma fp32[h], ln_beta fp32[h],
///     w1 fp32[h*h] (row-major [out,in]), b1 fp32[h],
///     w2 fp32[n*h] (row-major [n,in]),  b2 fp32[n]
///
///   DH02 (E2B linear probe): LayerNorm → Linear(H→4)
///     magic "DH02", hidden u32, n_class u32,
///     ln_gamma fp32[h], ln_beta fp32[h],
///     w2 fp32[n*h] (row-major [n,in]), b2 fp32[n] (zeros when export has no bias)
///
/// GELU is exact/erf (`nn.GELU()` default) — confirmed from the E4B graph
/// (approximate=false). LayerNorm eps=1e-5 — confirmed from both graphs.
final class DetectorHead {
    let hidden: Int
    let nClass: Int
    private let mlp: Bool        // DH01 = true (Linear→GELU between LN and the classifier)
    private let gamma: [Float]   // [hidden]
    private let beta: [Float]    // [hidden]
    private let w1: [Float]      // [hidden, hidden] row-major (DH01 only, else empty)
    private let b1: [Float]      // [hidden]                   (DH01 only, else empty)
    private let w2: [Float]      // [n_class, hidden] row-major
    private let b2: [Float]      // [n_class]

    enum LoadError: Error { case fileNotFound, badMagic, badShape, truncated }

    init(bundledFilename: String = "detector_head_v1") throws {
        guard let url = Bundle.main.url(forResource: bundledFilename, withExtension: "bin") else {
            throw LoadError.fileNotFound
        }
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        if data.count < 12 { throw LoadError.truncated }
        switch data.prefix(4) {
        case Data([0x44, 0x48, 0x30, 0x31]): self.mlp = true   // "DH01"
        case Data([0x44, 0x48, 0x30, 0x32]): self.mlp = false  // "DH02"
        default: throw LoadError.badMagic
        }
        let hidden = Int(data.withUnsafeBytes { $0.load(fromByteOffset: 4, as: UInt32.self) })
        let nClass = Int(data.withUnsafeBytes { $0.load(fromByteOffset: 8, as: UInt32.self) })
        if hidden == 0 || nClass == 0 { throw LoadError.badShape }
        self.hidden = hidden
        self.nClass = nClass

        let mlpFloats = mlp ? hidden * hidden + hidden : 0
        let expected = 12 + (hidden * 2 + mlpFloats + nClass * hidden + nClass) * 4
        if data.count < expected { throw LoadError.truncated }

        func readFloats(_ offset: Int, _ count: Int) -> [Float] {
            data.withUnsafeBytes { raw in
                let p = raw.baseAddress!.advanced(by: offset).assumingMemoryBound(to: Float.self)
                return Array(UnsafeBufferPointer(start: p, count: count))
            }
        }
        var off = 12
        self.gamma = readFloats(off, hidden);         off += hidden * 4
        self.beta  = readFloats(off, hidden);         off += hidden * 4
        if mlp {
            self.w1 = readFloats(off, hidden * hidden); off += hidden * hidden * 4
            self.b1 = readFloats(off, hidden);          off += hidden * 4
        } else {
            self.w1 = []
            self.b1 = []
        }
        self.w2 = readFloats(off, nClass * hidden); off += nClass * hidden * 4
        self.b2 = readFloats(off, nClass)
    }

    /// DH01: LayerNorm → Linear → GELU → Linear. DH02: LayerNorm → Linear.
    /// Returns `nClass` logits.
    func forward(_ activations: [Float]) -> [Float] {
        precondition(activations.count == hidden,
                     "activation dim mismatch: got \(activations.count), expected \(hidden)")

        // --- LayerNorm over the hidden dim ---
        var mean: Float = 0, meanSq: Float = 0
        activations.withUnsafeBufferPointer { p in
            vDSP_meanv(p.baseAddress!, 1, &mean, vDSP_Length(hidden))
            vDSP_measqv(p.baseAddress!, 1, &meanSq, vDSP_Length(hidden))
        }
        let invStd = 1.0 / sqrt(meanSq - mean * mean + 1e-5)
        var xn = [Float](repeating: 0, count: hidden)
        var negMean = -mean
        activations.withUnsafeBufferPointer { lp in
            xn.withUnsafeMutableBufferPointer { xp in
                vDSP_vsadd(lp.baseAddress!, 1, &negMean, xp.baseAddress!, 1, vDSP_Length(hidden))
            }
        }
        var scale = invStd
        xn.withUnsafeMutableBufferPointer { xp in
            vDSP_vsmul(xp.baseAddress!, 1, &scale, xp.baseAddress!, 1, vDSP_Length(hidden))
        }
        gamma.withUnsafeBufferPointer { gp in
            xn.withUnsafeMutableBufferPointer { xp in
                vDSP_vmul(xp.baseAddress!, 1, gp.baseAddress!, 1, xp.baseAddress!, 1, vDSP_Length(hidden))
            }
        }
        beta.withUnsafeBufferPointer { bp in
            xn.withUnsafeMutableBufferPointer { xp in
                vDSP_vadd(xp.baseAddress!, 1, bp.baseAddress!, 1, xp.baseAddress!, 1, vDSP_Length(hidden))
            }
        }

        // --- DH01 only: h = GELU(W1 @ xn + b1) ---
        var h = xn
        if mlp {
            h = b1
            w1.withUnsafeBufferPointer { wp in
                xn.withUnsafeBufferPointer { xp in
                    h.withUnsafeMutableBufferPointer { hp in
                        cblas_sgemv(CblasRowMajor, CblasNoTrans,
                                    Int32(hidden), Int32(hidden), 1.0,
                                    wp.baseAddress!, Int32(hidden),
                                    xp.baseAddress!, 1, 1.0, hp.baseAddress!, 1)
                    }
                }
            }
            // GELU (exact, erf-based)
            let invSqrt2 = 1.0 / Float(2).squareRoot()
            for i in 0..<h.count { h[i] = 0.5 * h[i] * (1.0 + erff(h[i] * invSqrt2)) }
        }

        // --- Classifier: y = W2 @ h + b2  (W2 is [n_class, hidden] row-major) ---
        var y = b2
        w2.withUnsafeBufferPointer { wp in
            h.withUnsafeBufferPointer { hp in
                y.withUnsafeMutableBufferPointer { yp in
                    cblas_sgemv(CblasRowMajor, CblasNoTrans,
                                Int32(nClass), Int32(hidden), 1.0,
                                wp.baseAddress!, Int32(hidden),
                                hp.baseAddress!, 1, 1.0, yp.baseAddress!, 1)
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

    // On-device model catalog. Two Gemma 4 E4B variants, each downloadable
    // independently (they coexist on disk under distinct filenames) and
    // switchable in the AI-providers settings, so the QAT build and the
    // litert-community prebuilt can be compared head to head. Each gets its
    // own litert Metal-compile cache dir.
    struct LocalModel: Identifiable, Equatable {
        let id: String            // suffix of the "iosLocal:<id>" selectedModel key
        let displayName: String
        let url: URL
        let filename: String
        let cacheSubdir: String
        let approxSize: String
        // Optional AI-text-detection capability (detector). When all three are
        // set, this model can ALSO run detection: the same base file does normal
        // chat generation with no LoRA (identity), or detection with the adapter
        // scoped in + the bundled head applied — conditionally, per conversation.
        // The adapter is downloaded with the model; the head is bundled in-app.
        var adapterFilename: String? = nil
        var adapterURL: URL? = nil
        var headBlobResource: String? = nil     // bundled DetectorHead blob (no extension)
        // Device gating for onboarding/UI: peak-RAM budget to run this model
        // on the GPU backend, and the user-facing requirement string.
        var minimumRAMBytes: UInt64 = 5 << 30
        var requiredRAMDisplay: String = "6 GB"
        var supportsDetection: Bool { adapterFilename != nil && headBlobResource != nil }
        var isSupportedOnThisDevice: Bool {
            ProcessInfo.processInfo.physicalMemory >= minimumRAMBytes
        }
        var selectedModelKey: String { "iosLocal:\(id)" }
    }

    // The on-device model registry. ONE entry per shipped model; everything
    // downstream (settings rows, downloads incl. LoRA adapter, chat engine,
    // detection engine + bundled head, debug menu) is driven from this list —
    // adding a future model is a single LocalModel entry here (plus, for
    // detection-capable models, converting its head via
    // scripts/convert_detector_head.py and bundling the .bin).
    static let models: [LocalModel] = [
        LocalModel(
            id: "gemma-4-e2b-detector-v2",
            displayName: "Gemma E2B",
            url: URL(string: "https://huggingface.co/DarrenJiaImbue/gemma-4-e2b-ai-text-detector-v2/resolve/main/model.litertlm")!,
            filename: "model-e2b-detector-v2.litertlm",
            cacheSubdir: "detector_e2b_v2_gpu_v1",
            approxSize: "~2.2 GB",
            adapterFilename: "lora_adapter-e2b-detector-v2.tflite",
            adapterURL: URL(string: "https://huggingface.co/DarrenJiaImbue/gemma-4-e2b-ai-text-detector-v2/resolve/main/lora_adapter.tflite")!,
            headBlobResource: "detector_head_e2b_v2"),
    ]

    /// The currently-selected model, if it can run AI-text detection.
    var detectionModel: LocalModel? { selectedModel.supportsDetection ? selectedModel : nil }

    static func model(forID id: String) -> LocalModel? { models.first { $0.id == id } }
    static func model(forKey key: String) -> LocalModel? {
        guard key.hasPrefix("iosLocal:") else { return nil }
        return model(forID: String(key.dropFirst("iosLocal:".count)))
    }

    private static let selectedModelDefaultsKey = "localSelectedModelID"

    // Which catalog model the engine loads + classifies with. Persisted across
    // relaunches; defaults to the first (QAT) model.
    @Published private(set) var selectedModelID: String =
        UserDefaults.standard.string(forKey: LocalInferenceService.selectedModelDefaultsKey)
            ?? LocalInferenceService.models[0].id

    var selectedModel: LocalModel {
        Self.model(forID: selectedModelID) ?? Self.models[0]
    }


    private let downloader: ModelDownloader
    // Chat engine over the selected model's .litertlm (zero-LoRA identity).
    private var engine: Engine?
    private var loadTask: Task<Void, Error>?
    private var statusPollTimer: Timer?

    private var samplerConfig: SamplerConfig?

    private var baseConversation: Conversation?
    private var baseSystemMessage: String?
    private var baseRegexConstraint: String?
    private var baseMaxOutputTokens: Int?

    // Detection runs on a DEDICATED engine over the selected model's file —
    // separate from the chat `engine` — to avoid the INTERLEAVE_BUG (running
    // LoRA-scoped detection after a chat decode loop on one engine produced
    // garbage). Both engines mmap the same file, so weights aren't duplicated;
    // the detection engine only adds its own compile cache + KV/context state.
    // The adapter is scoped per detection conversation (chat conversations on
    // the chat engine get none). All cleared on model switch.
    private var detectionEngine: Engine?
    private var detectionLoadTask: Task<Void, Error>?
    private var detectorHead: DetectorHead?

    private let inferenceQueue = AsyncSerialQueue()
    private init() {
        // Enable LiteRT benchmark timing so getBenchmarkInfo() returns per-turn
        // prefill/decode token counts + tokens/sec + time-to-first-token for the
        // "[Filter] infer:" breakdown below. Timing-only collection (not the
        // synthetic benchmark-only mode); negligible overhead.
        ExperimentalFlags.optIntoExperimentalAPIs()
        ExperimentalFlags.enableBenchmark = true
        // Speculative decoding OFF (this is the default, made explicit). Critical
        // for AI-text detection: it reads the `activations` aux tensor, which is
        // exactly the feature an MTP drafter consumes — a speculative decode path
        // could change which position's hidden state is exposed and corrupt the
        // classifier head's input. The flag is engine-global (read at engine
        // build; no per-engine override), so this also covers the chat engine —
        // fine, the app doesn't use speculative decoding anywhere.
        ExperimentalFlags.enableSpeculativeDecoding = false
        // Background-session singleton: AppDelegate forwards relaunch
        // events through ModelDownloader.shared, so this service must use
        // the same instance.
        self.downloader = ModelDownloader.shared

        // Reconcile persisted selection + disk against the model registry:
        //  - a persisted id that no longer exists falls back to the first model;
        //  - files and compile caches belonging to removed registry entries are
        //    deleted to reclaim space. Registry-driven, so retiring a model is
        //    just removing its LocalModel entry.
        if Self.model(forID: selectedModelID) == nil {
            selectedModelID = Self.models[0].id
            UserDefaults.standard.set(selectedModelID, forKey: Self.selectedModelDefaultsKey)
        }
        let knownFiles = Set(Self.models.flatMap { [$0.filename, $0.adapterFilename].compactMap { $0 } })
        if let entries = try? FileManager.default.contentsOfDirectory(
            at: downloader.modelsDirectory, includingPropertiesForKeys: nil) {
            for url in entries
            where ["litertlm", "tflite"].contains(url.pathExtension)
                && !knownFiles.contains(url.lastPathComponent) {
                try? FileManager.default.removeItem(at: url)
                print("[Models] removed unreferenced \(url.lastPathComponent)")
            }
        }
        let cacheRoot = FileManager.default
            .urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let knownCaches = Set(Self.models.flatMap { [$0.cacheSubdir, $0.cacheSubdir + "_detect"] })
        let cacheBase = cacheRoot.appendingPathComponent("litertlm_cache", isDirectory: true)
        if let dirs = try? FileManager.default.contentsOfDirectory(
            at: cacheBase, includingPropertiesForKeys: nil) {
            for dir in dirs where !knownCaches.contains(dir.lastPathComponent) {
                try? FileManager.default.removeItem(at: dir)
            }
        }

        self.downloader.activeFilename = selectedModel.filename
        self.downloader.totalBytesFallbackDisplay = selectedModel.approxSize
        refreshStatusFromDisk()
        observeDownloader()
        // Pick up any download iOS continued while the app was suspended
        // or killed; also reflect persisted resume data into the UI.
        Task { await self.downloader.reconcileWithSession() }
    }

    // MARK: - Public API

    /// `modelName` (from the JS "iosLocal:<id>" key) is validated against the
    /// selected registry model — with a single-model registry there is nothing
    /// to switch to, so a mismatch is logged and the selected model is used.
    /// `maxOutputTokens` overrides the 24-token verdict cap for freeform
    /// generation callers (e.g. "Bounce a Tweet" phrase suggestions).
    func classify(systemMessage: String, userMessage: String, imageUrls: [String] = [], regexConstraint: String? = nil, modelName: String? = nil, maxOutputTokens: Int? = nil) async throws -> String {
        if let modelName, modelName != selectedModel.id {
            print("[Filter] WARN: requested model \(modelName) ≠ selected \(selectedModel.id) — using selected")
        }
        return try await classifyInternal(
            tag: "Filter", systemMessage: systemMessage,
            userMessage: userMessage, imageUrls: imageUrls,
            regexConstraint: regexConstraint, maxOutputTokens: maxOutputTokens)
    }

    // MARK: - Debug harness

    /// Structured result of a single `debugRun`, surfaced in the in-app Debug
    /// screen so on-device model behaviour + latency can be inspected without
    /// scraping the console logs.
    struct InferenceStats: Equatable, Sendable {
        var modelDisplayName: String
        var output: String
        var loadSec: Double     // ensureReady() — 0 when the engine was already loaded
        var createSec: Double   // createConversation (prefill of system + preface)
        var inferSec: Double    // sendMessage (prefill of prompt + decode)
        var wallSec: Double     // create + infer (excludes model load)
        var ttftMs: Double      // time-to-first-token, from the runtime benchmark
        var prefillTokens: Int
        var prefillTokPerSec: Double
        var decodeTokens: Int
        var decodeTokPerSec: Double
    }

    /// Run one free-form prompt on the currently-selected model and return
    /// timing + token stats. Deliberately does NOT reuse the production
    /// base-conversation cache (getOrBuildBase) — it builds a throwaway
    /// conversation so a debug run never perturbs the live filter path, and so
    /// `maxOutputTokens` can be raised well past the 24-token verdict cap to
    /// get readable output. Serialized on the shared inference queue so it
    /// never races a concurrent classify() on the same engine.
    ///
    /// Intentionally UNCONSTRAINED: unlike the production classify() path, which
    /// attaches an LlGuidance `regexConstraint` that forces the pipe-delimited
    /// yes/no verdict grammar, debug runs let the model generate free-form text.
    /// This is required to assess raw model quality — a constrained decode can
    /// mask a model that would otherwise produce a wrong/garbled answer. There
    /// is deliberately no regexConstraint parameter here so a caller can't
    /// re-introduce a constraint.
    func debugRun(
        systemMessage: String, userMessage: String,
        maxOutputTokens: Int = 256
    ) async throws -> InferenceStats {
        let loadStart = Date()
        try await ensureReady()
        let loadSec = Date().timeIntervalSince(loadStart)
        let modelName = selectedModel.displayName

        return try await inferenceQueue.run { [weak self] in
            guard let self else { throw LocalInferenceError.engineNotLoaded }
            guard let engine = await self.engine,
                  let sampler = await self.samplerConfig
            else { throw LocalInferenceError.engineNotLoaded }

            let createStart = Date()
            // regexConstraint deliberately omitted (defaults to nil) so decode
            // is unconstrained free-form text — see the note on debugRun above.
            let config = ConversationConfig(
                systemMessage: Message(systemMessage, role: .system),
                samplerConfig: sampler,
                prefillPrefaceOnInit: true,
                maxOutputTokens: maxOutputTokens
            )
            let convo = try await engine.createConversation(with: config)
            let createSec = Date().timeIntervalSince(createStart)

            let inferStart = Date()
            let response = try await convo.sendMessage(Message(userMessage, role: .user))
            let inferSec = Date().timeIntervalSince(inferStart)
            let raw = response.toString

            var ttftMs = 0.0, prefillTps = 0.0, decodeTps = 0.0
            var prefillTok = 0, decodeTok = 0
            if let b = try? convo.getBenchmarkInfo() {
                ttftMs = Double(b.timeToFirstTokenInSecond) * 1000
                prefillTok = Int(b.lastPrefillTokenCount)
                prefillTps = Double(b.lastPrefillTokensPerSecond)
                decodeTok = Int(b.lastDecodeTokenCount)
                decodeTps = Double(b.lastDecodeTokensPerSecond)
            }

            let stats = InferenceStats(
                modelDisplayName: modelName,
                output: raw,
                loadSec: loadSec,
                createSec: createSec,
                inferSec: inferSec,
                wallSec: createSec + inferSec,
                ttftMs: ttftMs,
                prefillTokens: prefillTok,
                prefillTokPerSec: prefillTps,
                decodeTokens: decodeTok,
                decodeTokPerSec: decodeTps
            )
            print(String(
                format: "[Debug] %@ wall=%.2fs (load=%.2fs create=%.2fs infer=%.2fs) ttft=%.0fms prefill=%d@%.0f/s decode=%d@%.0f/s",
                modelName, stats.wallSec, loadSec, createSec, inferSec,
                ttftMs, prefillTok, prefillTps, decodeTok, decodeTps))
            print("[Debug] output: \(raw)")
            return stats
        }
    }

    /// True when `model`'s file is on disk — used by the Debug screen to list
    /// only loadable variants.
    func isDownloaded(_ model: LocalModel) -> Bool {
        downloader.isDownloaded(model.filename)
    }

    /// Run the full inference path: image fetch → queue → base build/clone
    /// → sendMessage → response. `tag` is the log prefix (e.g. "Filter" for
    /// production calls).
    private func classifyInternal(
        tag: String, systemMessage: String, userMessage: String, imageUrls: [String] = [],
        regexConstraint: String? = nil, maxOutputTokens: Int? = nil
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
                    maxOutputTokens: maxOutputTokens,
                    sampler: sampler, engine: engine)
                let baseSec = Date().timeIntervalSince(baseStart)
                let cloneStart = Date()
                let convo = try base.clone()
                let cloneSec = Date().timeIntervalSince(cloneStart)
                let inferStart = Date()
                let response = try await convo.sendMessage(
                    Message(contents: contents, role: .user))
                let inferSec = Date().timeIntervalSince(inferStart)
                let raw = response.toString
                // Per-turn breakdown of the sendMessage (infer) time: prefill of
                // the post vs decode of the verdict. The DECODE token count is the
                // main driver of infer variance — a post that decodes to the
                // maxOutputTokens=24 cap costs ~2x one that stops early (~7 tok).
                // ttft ≈ prefill + first-decode latency. litertlm does NOT retry a
                // failed inference, so a large infer with no RETRY log = more decode.
                if let b = try? convo.getBenchmarkInfo() {
                    // Derive per-step wall time from count / (tokens/sec). This is
                    // the exact measured step time recovered from the ratio the
                    // runtime reports (tok/s = tokens / seconds), not an estimate.
                    let prefillMs = b.lastPrefillTokensPerSecond > 0
                        ? Double(b.lastPrefillTokenCount) / b.lastPrefillTokensPerSecond * 1000 : 0
                    let decodeMs = b.lastDecodeTokensPerSecond > 0
                        ? Double(b.lastDecodeTokenCount) / b.lastDecodeTokensPerSecond * 1000 : 0
                    print(String(
                        format: "[%@] infer: ttft=%.0fms prefill=%d tok@%.0f/s %.1fms decode=%d tok@%.0f/s %.1fms rawlen=%d",
                        tag, b.timeToFirstTokenInSecond * 1000,
                        b.lastPrefillTokenCount, b.lastPrefillTokensPerSecond, prefillMs,
                        b.lastDecodeTokenCount, b.lastDecodeTokensPerSecond, decodeMs,
                        raw.count))
                }
                return (raw, baseSec, cloneSec, inferSec, rebuiltBase)
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
                print(String(format: "[%@] raw wall=%.2fs: %@", tag, wallSec, raw))
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
                print(String(format: "[%@] raw(retry) wall=%.2fs: %@", tag, wallSec2, raw))
                await self.dropBaseConversation()
                return raw
            }
        }
    }

    private func getOrBuildBase(
        systemMessage: String, regexConstraint: String?,
        maxOutputTokens: Int?,
        sampler: SamplerConfig, engine: Engine
    ) async throws -> (Conversation, Bool) {
        if let base = self.baseConversation,
           self.baseSystemMessage == systemMessage,
           self.baseRegexConstraint == regexConstraint,
           self.baseMaxOutputTokens == maxOutputTokens,
           base.isAlive {
            return (base, false)
        }
        // Why did the base cache miss? Distinguishes a genuinely-absent base
        // (first call / dropped after a transient-error retry) from a
        // stale-key or dead-handle miss, so on-device logs pinpoint whether
        // the per-request rebuild is caused by clone/send failures dropping
        // the base vs. a changing system prompt / regex.
        let missReason: String
        if self.baseConversation == nil {
            missReason = "no-base"
        } else if !(self.baseConversation?.isAlive ?? false) {
            missReason = "base-dead"
        } else if self.baseSystemMessage != systemMessage {
            missReason = "system-changed"
        } else if self.baseRegexConstraint != regexConstraint {
            missReason = "regex-changed"
        } else if self.baseMaxOutputTokens != maxOutputTokens {
            missReason = "max-tokens-changed"
        } else {
            missReason = "unknown"
        }
        print("[Filter] base rebuild reason=\(missReason)")
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
            maxOutputTokens: maxOutputTokens ?? 24,
            regexConstraint: regexConstraint
        )
        let base = try await engine.createConversation(with: config)
        self.baseConversation = base
        self.baseSystemMessage = systemMessage
        self.baseRegexConstraint = regexConstraint
        self.baseMaxOutputTokens = maxOutputTokens
        return (base, true)
    }

    private func dropBaseConversation() {
        self.baseConversation = nil
        self.baseSystemMessage = nil
        self.baseRegexConstraint = nil
        self.baseMaxOutputTokens = nil
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

    /// Normalized expected bucket index over the softmax of the 4-class
    /// classifier head's logits — matches the detector training-pipeline
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
        guard downloader.isDownloaded(selectedModel.filename) else {
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
            await MainActor.run {
                self.engine = engine
                self.samplerConfig = sampler
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
        // Per-model Metal-compile cache so switching variants never reuses the
        // other model's compiled artifacts.
        return cacheRoot.appendingPathComponent(
            "litertlm_cache/\(selectedModel.cacheSubdir)", isDirectory: true)
    }

    private func buildEngine(cacheDir: URL) async throws -> Engine {
        // Upstream Gemma 4 E4B IT — single chat signature pair. Don't pin
        // decodeSignatureName / prefillSignatureFilter; the runtime will pick
        // the standard "decode" + "prefill_*" signatures bundled in the file.
        //
        // visionBackend is nil: the QAT export is text-only (no
        // TF_LITE_VISION_ENCODER submodel), and passing a vision backend makes
        // createConversation fail with `NOT_FOUND: TF_LITE_VISION_ENCODER`. Nil
        // is also safe for the prebuilt variant (its vision executor simply
        // isn't initialized). Text classification doesn't need it. Loads the
        // SELECTED model's file (may differ from the active download target).
        let cfg = try EngineConfig(
            modelPath: self.downloader.modelPath(for: self.selectedModel.filename).path,
            backend: .gpu,
            visionBackend: nil,
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

    // MARK: - AI-text detection (on-device detector)

    /// Ternary decision from the continuous detector score (doc §5 thresholds,
    /// calibrated on full_v3 val). `score` ∈ [0,1]: 0 = clearly human,
    /// 1 = clearly AI-generated.
    enum DetectionVerdict: String, Sendable {
        case human = "Human"
        case edited = "AI-edited"
        case generated = "AI-generated"

        static func from(score: Float) -> DetectionVerdict {
            if score >= 0.96 { return .generated }   // fully-AI vs rest
            if score >= 0.16 { return .edited }      // human vs any-AI
            return .human
        }
    }

    struct DetectionResult: Equatable, Sendable {
        var score: Float          // (0·p0 + 1·p1 + 2·p2 + 3·p3) / 3, in [0,1]
        var probs: [Float]        // softmax over the 4 classes
        var logits: [Float]       // raw 4-class head logits (JS bridge exposes these)
        var verdict: DetectionVerdict
        var loadSec: Double       // engine + head load (0 when already ready)
        var inferSec: Double      // createConversation + sendMessage (prefill + 1 decode)
        var headSec: Double       // Accelerate head forward
        var wallSec: Double
    }

    /// Whether the selected model can run detection AND its files are on disk.
    /// The base file already gates chat; detection additionally needs the
    /// adapter. The head is app-bundled and checked at load.
    func detectorFilesPresent() -> Bool {
        guard let m = detectionModel, let adapter = m.adapterFilename else { return false }
        return downloader.isDownloaded(m.filename) && downloader.isDownloaded(adapter)
    }

    /// Build the DEDICATED detection engine over `model`'s file + load the
    /// bundled head, once (two-engine isolation — separate from the chat engine).
    func ensureDetectorReady(_ model: LocalModel) async throws {
        if detectionEngine != nil, detectorHead != nil { return }
        guard detectorFilesPresent() else { throw LocalInferenceError.modelNotDownloaded }
        if let task = detectionLoadTask { try await task.value; return }

        let task = Task<Void, Error> { [weak self] in
            guard let self else { return }
            guard let res = model.headBlobResource else {
                throw LocalInferenceError.detectionUnavailable
            }
            let head = try DetectorHead(bundledFilename: res)  // throws until bundled
            let cacheRoot = FileManager.default
                .urls(for: .cachesDirectory, in: .userDomainMask)[0]
            // Distinct cache dir from the chat engine's so the two engines over
            // the same file don't race on compile artifacts.
            let cacheDir = cacheRoot.appendingPathComponent(
                "litertlm_cache/\(model.cacheSubdir)_detect", isDirectory: true)
            try? FileManager.default.createDirectory(
                at: cacheDir, withIntermediateDirectories: true)
            let cfg = try EngineConfig(
                modelPath: self.downloader.modelPath(for: model.filename).path,
                backend: Self.detectionBackend, visionBackend: nil,
                maxNumTokens: 1024, cacheDir: cacheDir.path)
            let engine = Engine(engineConfig: cfg)
            try await engine.initialize()
            await MainActor.run {
                self.detectionEngine = engine
                self.detectorHead = head
            }
        }
        detectionLoadTask = task
        do { try await task.value } catch { detectionLoadTask = nil; throw error }
        detectionLoadTask = nil
    }

    /// Run AI-text detection on `text` (doc §5): scope the adapter for this one
    /// conversation, prefill the prompt + one decode step, read the
    /// `activations` aux output, project through the head, and score.
    func detectAIText(_ text: String) async throws -> DetectionResult {
        guard let model = detectionModel, let adapterFilename = model.adapterFilename else {
            throw LocalInferenceError.detectionUnavailable
        }
        guard detectorFilesPresent() else { throw LocalInferenceError.modelNotDownloaded }
        let loadStart = Date()
        try await ensureDetectorReady(model)     // dedicated detection engine + head
        let loadSec = Date().timeIntervalSince(loadStart)
        let adapterURL = downloader.modelPath(for: adapterFilename)
        // Match the training recipe (ai-detection-demo inference): the head was
        // trained on the last-token hidden state of clean_text(raw) — lowercased
        // + whitespace-collapsed — with NO chat template. Clean here + set
        // skipChatTemplate below. (Chat-templating puts a content-free boundary
        // token at the last position → mushy/middling scores.)
        let cleaned = Self.cleanTextForClassifier(text)

        return try await inferenceQueue.run { [weak self] in
            guard let self else { throw LocalInferenceError.engineNotLoaded }
            guard let engine = await self.detectionEngine,
                  let head = await self.detectorHead else {
                throw LocalInferenceError.engineNotLoaded
            }
            let wallStart = Date()
            // Scope the adapter for THIS conversation only (conditional
            // activation). maxOutputTokens=1 → prefill the prompt + one decode
            // step so `activations` holds the last-token hidden state.
            // skipChatTemplate: true → prefill the raw cleaned text verbatim so
            // the last position is a content token (what the head was trained on).
            let sampler = try SamplerConfig(topK: 1, topP: 1.0, temperature: 1.0)
            let cfg = ConversationConfig(
                samplerConfig: sampler,
                prefillPrefaceOnInit: false,
                scopedLoraFile: adapterURL,
                maxOutputTokens: 1,
                skipChatTemplate: true)

            let inferStart = Date()
            let convo = try await engine.createConversation(with: cfg)
            _ = try await convo.sendMessage(Message(cleaned, role: .user))
            let activations = try convo.getAuxiliaryOutput(name: "activations")  // [2560]
            let inferSec = Date().timeIntervalSince(inferStart)

            let headStart = Date()
            let logits = head.forward(activations)   // 4-class logits
            let headSec = Date().timeIntervalSince(headStart)

            // Reuse the existing scorer from the old detection path — the
            // expected-bucket formula is identical regardless of which head
            // produced the 4 logits.
            let score = Self.aiConfidence(fromLogits: logits)
            // Softmax probabilities, for the debug display only.
            let maxLogit = logits.max() ?? 0
            let exps = logits.map { exp($0 - maxLogit) }
            let z = exps.reduce(0, +)
            let probs = z > 0 ? exps.map { $0 / z } : logits.map { _ in Float(0) }

            let result = DetectionResult(
                score: score, probs: probs, logits: logits,
                verdict: DetectionVerdict.from(score: score),
                loadSec: loadSec, inferSec: inferSec, headSec: headSec,
                wallSec: Date().timeIntervalSince(wallStart))
            print(String(
                format: "[Detect] score=%.3f verdict=%@ (load=%.2fs infer=%.2fs head=%.1fms) probs=%@",
                score, result.verdict.rawValue, loadSec, inferSec, headSec * 1000,
                probs.map { String(format: "%.3f", $0) }.joined(separator: ",")))

            if Self.detectionActivationDiagnostics {
                print("[Detect] activations(adapter): \(Self.activationStats(activations))")
                print("[Detect] head logits=[\(logits.map { String(format: "%.4f", $0) }.joined(separator: ", "))]")
                if let b = try? convo.getBenchmarkInfo() {
                    // Which position's activations we read depends on how the
                    // prompt splits into prefill vs decode. ARCHITECTURE §5 wants
                    // the last INPUT token's hidden state.
                    print("[Detect] tokens: prefill=\(b.lastPrefillTokenCount) decode=\(b.lastDecodeTokenCount)")
                }
                // Definitive "is the adapter doing anything?" check: run the SAME
                // text with NO adapter (base model) on this engine and compare
                // activations. If L2Δ≈0 the adapter is not affecting the forward
                // pass (not bound, or its data is all-zero — cross-check the
                // runtime [LoRA-DBG] logs to tell which).
                let baseCfg = ConversationConfig(
                    samplerConfig: sampler, prefillPrefaceOnInit: false,
                    maxOutputTokens: 1, skipChatTemplate: true)
                let baseConvo = try await engine.createConversation(with: baseCfg)
                _ = try await baseConvo.sendMessage(Message(cleaned, role: .user))
                let baseAct = try baseConvo.getAuxiliaryOutput(name: "activations")
                let delta = Self.l2Delta(activations, baseAct)
                let baseScore = Self.aiConfidence(fromLogits: head.forward(baseAct))
                print(String(
                    format: "[Detect] adapter-vs-base: L2Δ=%.4f (rel=%.4f) score_adapter=%.3f score_base=%.3f",
                    delta, delta / max(Self.l2Norm(baseAct), 1e-6), score, baseScore))
                print("[Detect] activations(base):    \(Self.activationStats(baseAct))")
            }
            return result
        }
    }

    // Detection diagnostics: when true, detectAIText logs activation stats and
    // ALSO runs a no-adapter forward on the same text to compare (doubles
    // detection inference — never leave on for the production per-post path).
    // Debug-only tool; flip on when diagnosing detection regressions.
    static let detectionActivationDiagnostics = false


    // Backend for the detection engine. The mushy-score bug turned out to be a
    // stray BOS token (fixed in the runtime), NOT a Metal LoRA issue — CPU and
    // GPU scored identically throughout. GPU is ~4x faster per detection. The
    // "Failed to get buffer requirements for lora_atten_*" warnings on Metal
    // are benign (CPU-fallback buffers still feed the graph correctly —
    // verified: GPU scores match the CPU reference to ~0.01).
    static let detectionBackend: Backend = .gpu

    nonisolated static func activationStats(_ v: [Float]) -> String {
        guard let first = v.first else { return "empty" }
        var sum: Float = 0, sumSq: Float = 0, mn = first, mx = first
        var nonzero = 0, bad = 0
        for x in v {
            if x.isNaN || x.isInfinite { bad += 1; continue }
            sum += x; sumSq += x * x
            if x != 0 { nonzero += 1 }
            mn = Swift.min(mn, x); mx = Swift.max(mx, x)
        }
        return String(
            format: "n=%d mean=%.4f l2=%.3f min=%.3f max=%.3f nonzero=%d nan/inf=%d first=[%@]",
            v.count, sum / Float(v.count), sqrt(sumSq), mn, mx, nonzero, bad,
            v.prefix(4).map { String(format: "%.4f", $0) }.joined(separator: ","))
    }
    nonisolated static func l2Norm(_ v: [Float]) -> Float { sqrt(v.reduce(0) { $0 + $1 * $1 }) }
    nonisolated static func l2Delta(_ a: [Float], _ b: [Float]) -> Float {
        guard a.count == b.count else { return -1 }
        var s: Float = 0
        for i in 0..<a.count { let d = a[i] - b[i]; s += d * d }
        return sqrt(s)
    }


    func startDownload(_ model: LocalModel) {
        if case .downloading = downloader.status { return }
        downloader.activeFilename = model.filename
        downloader.totalBytesFallbackDisplay = model.approxSize
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.downloader.download(from: model.url)
                // Detection-capable models also need the LoRA adapter (small);
                // the classifier head is bundled in-app, not downloaded.
                if let adapterFilename = model.adapterFilename,
                   let adapterURL = model.adapterURL {
                    self.downloader.activeFilename = adapterFilename
                    try await self.downloader.download(from: adapterURL)
                }
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

    func deleteModel(_ model: LocalModel) {
        if model.id == selectedModelID { unloadEngine() }
        downloader.activeFilename = model.filename
        downloader.deleteModel()
        // Drop only this variant's Metal-compile cache.
        let cacheRoot = FileManager.default
            .urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let modelCacheDir = cacheRoot.appendingPathComponent(
            "litertlm_cache/\(model.cacheSubdir)", isDirectory: true)
        try? FileManager.default.removeItem(at: modelCacheDir)
        refreshStatusFromDisk()
    }

    // Switch which catalog model the engine loads. Persists the choice, unloads
    // the current engine (the newly-selected model lazily reloads on the next
    // classify), and points the downloader's status at it.
    func selectModel(_ model: LocalModel) {
        guard model.id != selectedModelID else { return }
        unloadEngine()
        selectedModelID = model.id
        UserDefaults.standard.set(model.id, forKey: Self.selectedModelDefaultsKey)
        downloader.activeFilename = model.filename
        refreshStatusFromDisk()
    }

    // Per-variant status for the settings UI, independent of which model is the
    // active download target or currently loaded. A detection model's adapter
    // download counts as the model still downloading — otherwise the row reads
    // "Downloaded — tap to use" while the adapter is mid-flight.
    func downloadStatus(for model: LocalModel) -> ModelStatus {
        if downloader.activeFilename == model.filename
            || (model.adapterFilename != nil && downloader.activeFilename == model.adapterFilename) {
            switch downloader.status {
            case .downloading(let p): return .downloading(progress: p)
            case .paused(let p): return .paused(progress: p)
            case .failed(let m): return .error(m)
            default: break
            }
        }
        guard downloader.isDownloaded(model.filename) else { return .notDownloaded }
        if model.id == selectedModelID {
            if engine != nil { return .ready }
            if case .loading = modelStatus { return .loading }
        }
        return .downloaded
    }

    func unloadEngine() {
        baseConversation = nil
        baseSystemMessage = nil
        engine = nil
        detectionEngine = nil  // dedicated detection engine — rebuild for the new model
        detectionLoadTask = nil
        detectorHead = nil     // per-model; reload for the newly-selected model
        samplerConfig = nil
        if downloader.isDownloaded(selectedModel.filename) {
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
        if downloader.isDownloaded(selectedModel.filename) {
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
            if downloader.isDownloaded(selectedModel.filename) {
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
    case detectionUnavailable

    var errorDescription: String? {
        switch self {
        case .modelNotDownloaded:
            return "Local model has not been downloaded yet."
        case .engineNotLoaded:
            return "Local inference engine is not loaded."
        case .detectionUnavailable:
            return "The selected model does not support AI-text detection."
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
