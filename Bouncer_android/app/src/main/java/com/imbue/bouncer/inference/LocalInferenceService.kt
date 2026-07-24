package com.imbue.bouncer.inference

import android.content.Context
import android.util.Log
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.ExperimentalApi
import com.google.ai.edge.litertlm.ExperimentalFlags
import com.google.ai.edge.litertlm.LoraConfig
import com.google.ai.edge.litertlm.SamplerConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.Executors

/**
 * On-device inference via LiteRT-LM, mirroring the iOS `LocalInferenceService`
 * (Bouncer_xcode/iOS (App)/LocalInferenceService.swift):
 *
 * - One chat engine (GPU, maxNumTokens 1024, greedy sampling) with a prefix-cached
 *   "base" conversation holding the system message; each classify request clones the
 *   base and sends only the per-post user message.
 * - A separate detection engine over the same model file (sharing one engine between
 *   chat and detection triggers an interleave bug), running per-call throwaway
 *   conversations with a conversation-scoped LoRA adapter, skipChatTemplate, and
 *   maxOutputTokens=1, whose "activations" auxiliary output feeds [DetectorHead].
 * - All engine work strictly serialized on a single dedicated thread.
 * - Transient engine errors trigger one rebuild-and-retry.
 */
class LocalInferenceService(
    private val app: Context,
    private val scope: CoroutineScope,
) {
    private val tag = "LocalInference"

    sealed interface ModelStatus {
        object NotDownloaded : ModelStatus
        data class Downloading(val progress: Double) : ModelStatus
        data class Paused(val progress: Double) : ModelStatus
        object Downloaded : ModelStatus
        object Loading : ModelStatus
        object Ready : ModelStatus
        data class Error(val message: String) : ModelStatus
    }

    data class DetectionResult(val aiConfidence: Float, val logits: FloatArray)

    class ModelNotDownloadedException : Exception("Local model is not downloaded")

    val downloader = ModelDownloader(app, scope)

    private val prefs = app.getSharedPreferences("local_inference", Context.MODE_PRIVATE)

    private val _selectedModelId = MutableStateFlow(
        prefs.getString(SELECTED_MODEL_KEY, null)
            ?.takeIf { LocalModels.forId(it) != null }
            ?: LocalModels.models[0].id
    )
    val selectedModelId: StateFlow<String> = _selectedModelId

    val selectedModel: LocalModel get() = LocalModels.forId(_selectedModelId.value) ?: LocalModels.models[0]

    private val _modelStatus = MutableStateFlow<ModelStatus>(ModelStatus.NotDownloaded)
    val modelStatus: StateFlow<ModelStatus> = _modelStatus

    /** e.g. "950 MB / 2.2 GB" while downloading; empty otherwise. */
    private val _downloadDetail = MutableStateFlow("")
    val downloadDetail: StateFlow<String> = _downloadDetail

    // The single thread that owns the engines; combined with the mutex (suspend
    // calls may hop threads) this reproduces the iOS AsyncSerialQueue.
    private val inferenceDispatcher =
        Executors.newSingleThreadExecutor { Thread(it, "litertlm-inference") }.asCoroutineDispatcher()
    private val inferenceMutex = Mutex()

    // Engine state: only touched while holding inferenceMutex on inferenceDispatcher.
    private var engine: Engine? = null
    private var engineModelId: String? = null
    private var baseConversation: Conversation? = null
    private var baseSystemMessage: String? = null
    private var baseRegexConstraint: String? = null
    private var baseMaxOutputTokens: Int? = null
    private var detectionEngine: Engine? = null
    private var detectionEngineModelId: String? = null
    private var detectorHead: DetectorHead? = null

    init {
        @OptIn(ExperimentalApi::class)
        // Speculative decoding corrupts the "activations" auxiliary tensor the
        // detector head reads; keep it off, matching iOS.
        ExperimentalFlags.enableSpeculativeDecoding = false

        downloader.onStateChanged = { refreshStatus() }
        downloader.reconcile(selectedModel)
        cleanUpStaleFiles()
    }

    // ---------------------------------------------------------------- status

    private fun refreshStatus() {
        val engineLoaded = engineModelId == selectedModel.id && engine != null
        _modelStatus.value = when (val s = downloader.status) {
            is ModelDownloader.Status.NotStarted -> ModelStatus.NotDownloaded
            is ModelDownloader.Status.Downloading -> ModelStatus.Downloading(s.progress)
            is ModelDownloader.Status.Paused -> ModelStatus.Paused(s.progress)
            is ModelDownloader.Status.Failed -> ModelStatus.Error(s.message)
            is ModelDownloader.Status.Completed ->
                if (engineLoaded) ModelStatus.Ready else ModelStatus.Downloaded
        }
        _downloadDetail.value = if (downloader.totalBytes > 0) {
            android.text.format.Formatter.formatShortFileSize(app, downloader.downloadedBytes) +
                " / " +
                android.text.format.Formatter.formatShortFileSize(app, downloader.totalBytes)
        } else {
            ""
        }
    }

    // ------------------------------------------------------------- classify

    /**
     * Classifies via the chat engine. Returns the raw model output string (the JS
     * side owns prompt construction and verdict parsing).
     */
    suspend fun classify(
        systemMessage: String,
        userMessage: String,
        imageUrls: List<String>,
        regexConstraint: String?,
        modelName: String?,
        maxOutputTokens: Int?,
    ): String {
        val model = selectedModel
        if (modelName != null && modelName != model.id) {
            Log.w(tag, "classify: modelName=$modelName != selected=${model.id}; using selected")
        }
        if (imageUrls.isNotEmpty()) {
            // iOS is also effectively text-only (visionBackend is nil and the JS never
            // sends images for iosLocal models); accept and ignore.
            Log.w(tag, "classify: ignoring ${imageUrls.size} imageUrls (text-only model)")
        }
        if (!downloader.isDownloaded(model.filename)) throw ModelNotDownloadedException()

        return withContext(inferenceDispatcher) {
            inferenceMutex.withLock {
                try {
                    classifyLocked(model, systemMessage, userMessage, regexConstraint, maxOutputTokens)
                } catch (e: Exception) {
                    if (!isTransient(e)) throw e
                    Log.w(tag, "classify: transient error, rebuilding engine and retrying once", e)
                    rebuildEngineLocked(model)
                    val result = classifyLocked(model, systemMessage, userMessage, regexConstraint, maxOutputTokens)
                    // Mirror iOS: drop the base after a post-rebuild success so the next
                    // call re-prefills from a clean slate.
                    dropBaseLocked()
                    result
                }
            }
        }
    }

    private fun classifyLocked(
        model: LocalModel,
        systemMessage: String,
        userMessage: String,
        regexConstraint: String?,
        maxOutputTokens: Int?,
    ): String {
        val eng = ensureEngineLocked(model)
        val base = getOrBuildBaseLocked(eng, systemMessage, regexConstraint, maxOutputTokens)
        val started = System.currentTimeMillis()
        val clone = base.clone()
        val response = try {
            clone.sendMessage(userMessage)
        } finally {
            runCatching { clone.close() }
        }
        val text = response.toString()
        Log.i(tag, "classify: ${System.currentTimeMillis() - started}ms output=${text.take(80)}")
        return text
    }

    private fun ensureEngineLocked(model: LocalModel): Engine {
        engine?.let {
            if (engineModelId == model.id) return it
            // Model switched: tear everything down first.
            unloadLocked()
        }
        _modelStatus.value = ModelStatus.Loading
        val eng = buildEngineLocked(model, cacheSubdir = model.cacheSubdir)
        engine = eng
        engineModelId = model.id
        _modelStatus.value = ModelStatus.Ready
        return eng
    }

    private fun buildEngineLocked(model: LocalModel, cacheSubdir: String): Engine {
        val cacheDir = File(app.cacheDir, "litertlm_cache/$cacheSubdir").apply { mkdirs() }
        val config = EngineConfig(
            modelPath = downloader.modelPath(model.filename).absolutePath,
            backend = Backend.GPU(),
            // Text-only: a vision backend makes createConversation fail with
            // NOT_FOUND: TF_LITE_VISION_ENCODER (same constraint as iOS).
            visionBackend = null,
            audioBackend = null,
            maxNumTokens = 1024,
            cacheDir = cacheDir.absolutePath,
        )
        Log.i(tag, "building engine for ${model.id} (cache=$cacheSubdir)")
        val started = System.currentTimeMillis()
        val eng = Engine(config)
        eng.initialize()
        Log.i(tag, "engine ready in ${System.currentTimeMillis() - started}ms")
        return eng
    }

    private fun getOrBuildBaseLocked(
        eng: Engine,
        systemMessage: String,
        regexConstraint: String?,
        maxOutputTokens: Int?,
    ): Conversation {
        val effectiveMax = maxOutputTokens ?: DEFAULT_MAX_OUTPUT_TOKENS
        val cached = baseConversation
        if (cached != null) {
            val missReason = when {
                !cached.isAlive -> "base-dead"
                baseSystemMessage != systemMessage -> "system-changed"
                baseRegexConstraint != regexConstraint -> "regex-changed"
                baseMaxOutputTokens != effectiveMax -> "max-tokens-changed"
                else -> null
            }
            if (missReason == null) return cached
            Log.i(tag, "base conversation miss: $missReason")
            runCatching { cached.close() }
        } else {
            Log.i(tag, "base conversation miss: no-base")
        }

        val base = eng.createConversation(
            ConversationConfig(
                systemInstruction = Contents.of(systemMessage),
                samplerConfig = GREEDY_SAMPLER,
                // Prefill the system message now so clones share its KV cache.
                prefillPrefaceOnInit = true,
                maxOutputTokens = effectiveMax,
                regexConstraint = regexConstraint,
            )
        )
        baseConversation = base
        baseSystemMessage = systemMessage
        baseRegexConstraint = regexConstraint
        baseMaxOutputTokens = effectiveMax
        return base
    }

    private fun dropBaseLocked() {
        baseConversation?.let { runCatching { it.close() } }
        baseConversation = null
        baseSystemMessage = null
        baseRegexConstraint = null
        baseMaxOutputTokens = null
    }

    private fun rebuildEngineLocked(model: LocalModel) {
        Log.w(tag, "rebuilding engine")
        dropBaseLocked()
        engine?.let { runCatching { it.close() } }
        engine = null
        engineModelId = null
        ensureEngineLocked(model)
    }

    private fun isTransient(e: Exception): Boolean {
        val msg = e.message ?: return false
        return TRANSIENT_ERRORS.any { msg.contains(it) }
    }

    // ------------------------------------------------------------ detection

    fun detectorFilesPresent(): Boolean {
        val model = selectedModel
        return model.supportsDetection &&
            downloader.isDownloaded(model.filename) &&
            model.adapterFilename != null && downloader.isDownloaded(model.adapterFilename)
    }

    /** Runs the AI-text detector. Returns the confidence score and raw logits. */
    suspend fun detectAIText(text: String): DetectionResult {
        val model = selectedModel
        if (!model.supportsDetection) throw IllegalStateException("model ${model.id} has no detector")
        if (!detectorFilesPresent()) throw ModelNotDownloadedException()

        return withContext(inferenceDispatcher) {
            inferenceMutex.withLock {
                val eng = ensureDetectionEngineLocked(model)
                val head = detectorHead ?: DetectorHead.fromAsset(app, model.headAssetName!!).also {
                    detectorHead = it
                }
                val cleaned = cleanTextForClassifier(text)
                val started = System.currentTimeMillis()
                val convo = eng.createConversation(
                    ConversationConfig(
                        samplerConfig = GREEDY_SAMPLER,
                        prefillPrefaceOnInit = false,
                        // The LoRA adapter is scoped to this conversation only.
                        loraConfig = LoraConfig(
                            loraPath = downloader.modelPath(model.adapterFilename!!).absolutePath
                        ),
                        // Prefill + a single decode step is all the head needs.
                        maxOutputTokens = 1,
                        // Raw text, exactly as the detector was trained.
                        skipChatTemplate = true,
                    )
                )
                try {
                    convo.sendMessage(cleaned)
                    val activations = convo.getAuxiliaryOutput("activations")
                    val logits = head.forward(activations)
                    val score = DetectorHead.aiConfidence(logits)
                    Log.i(
                        tag,
                        "detect: ${System.currentTimeMillis() - started}ms score=$score " +
                            "logits=${logits.joinToString(",")}"
                    )
                    DetectionResult(score, logits)
                } finally {
                    runCatching { convo.close() }
                }
            }
        }
    }

    private fun ensureDetectionEngineLocked(model: LocalModel): Engine {
        detectionEngine?.let {
            if (detectionEngineModelId == model.id) return it
            runCatching { it.close() }
            detectionEngine = null
            detectionEngineModelId = null
        }
        val eng = buildEngineLocked(model, cacheSubdir = "${model.cacheSubdir}_detect")
        detectionEngine = eng
        detectionEngineModelId = model.id
        return eng
    }

    /**
     * Mirror of iOS `cleanTextForClassifier` / scripts/preprocess.py::clean_text():
     * lowercase then collapse all whitespace runs to single spaces. Must match the
     * preprocessing the detector head was trained with.
     */
    private fun cleanTextForClassifier(text: String): String =
        text.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")

    // ------------------------------------------------------- model management

    fun startDownload() = downloader.startDownload(selectedModel)
    fun pauseDownload() = downloader.pause()
    fun cancelDownload() = downloader.cancel(selectedModel)

    fun deleteModel() {
        val model = selectedModel
        scope.launch {
            unload()
            downloader.deleteModel(model)
            File(app.cacheDir, "litertlm_cache/${model.cacheSubdir}").deleteRecursively()
            File(app.cacheDir, "litertlm_cache/${model.cacheSubdir}_detect").deleteRecursively()
            downloader.reconcile(model)
        }
    }

    fun selectModel(model: LocalModel) {
        if (model.id == _selectedModelId.value) return
        prefs.edit().putString(SELECTED_MODEL_KEY, model.id).apply()
        _selectedModelId.value = model.id
        scope.launch {
            unload()
            downloader.reconcile(model)
        }
    }

    /** Tears down both engines (e.g. on model switch/delete); they lazily rebuild. */
    suspend fun unload() {
        withContext(inferenceDispatcher) {
            inferenceMutex.withLock { unloadLocked() }
        }
    }

    private fun unloadLocked() {
        dropBaseLocked()
        engine?.let { runCatching { it.close() } }
        engine = null
        engineModelId = null
        detectionEngine?.let { runCatching { it.close() } }
        detectionEngine = null
        detectionEngineModelId = null
        detectorHead = null
    }

    /** Deletes model/cache files no longer referenced by the registry. */
    private fun cleanUpStaleFiles() {
        val knownFiles = LocalModels.models.flatMap { listOfNotNull(it.filename, it.adapterFilename) }
        val knownPartials = knownFiles.flatMap { listOf("$it.part", "$it.meta") }
        downloader.modelsDirectory.listFiles()?.forEach { f ->
            if (f.isFile && f.name !in knownFiles && f.name !in knownPartials) {
                Log.i(tag, "cleanup: deleting stale ${f.name}")
                f.delete()
            }
        }
        val knownCaches = LocalModels.models.flatMap { listOf(it.cacheSubdir, "${it.cacheSubdir}_detect") }
        File(app.cacheDir, "litertlm_cache").listFiles()?.forEach { d ->
            if (d.isDirectory && d.name !in knownCaches) {
                Log.i(tag, "cleanup: deleting stale cache ${d.name}")
                d.deleteRecursively()
            }
        }
    }

    companion object {
        private const val SELECTED_MODEL_KEY = "localSelectedModelID"
        private const val DEFAULT_MAX_OUTPUT_TOKENS = 24

        // topK=1 makes decoding deterministic argmax regardless of temperature.
        private val GREEDY_SAMPLER = SamplerConfig(topK = 1, topP = 1.0, temperature = 1.0)

        // Error substrings that warrant one engine rebuild + retry (mirrors iOS; the
        // strings originate in the shared C++ runtime so they match across bindings).
        private val TRANSIENT_ERRORS = listOf(
            "sendMessage returned null",
            "Failed to invoke the compiled model",
            "Failed to create conversation",
            "Failed to clone the conversation",
            "Execution manager is not available",
            "Failed to call nativeSendMessage",
        )
    }
}
