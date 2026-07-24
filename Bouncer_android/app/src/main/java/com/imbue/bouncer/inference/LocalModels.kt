package com.imbue.bouncer.inference

import android.app.ActivityManager
import android.content.Context

/**
 * A downloadable on-device model. Mirrors the iOS `LocalModel` registry in
 * Bouncer_xcode/iOS (App)/LocalInferenceService.swift — keep the two in sync,
 * along with the static `__iosLocalModels` catalog in
 * app/src/main/assets/web_ext_gecko/bridge_page.js.
 */
data class LocalModel(
    val id: String,
    val displayName: String,
    val url: String,
    val filename: String,
    /** Subdirectory for the engine's compiled-weights cache; bump to invalidate. */
    val cacheSubdir: String,
    val approxSize: String,
    /** Used for the free-disk-space precheck before downloading. */
    val approxSizeBytes: Long,
    /** LoRA adapter for AI-text detection; null if the model doesn't support detection. */
    val adapterFilename: String? = null,
    val adapterUrl: String? = null,
    /** Bundled classifier-head blob asset; null if the model doesn't support detection. */
    val headAssetName: String? = null,
    val minimumRamBytes: Long = 5L shl 30,
    val requiredRamDisplay: String = "6 GB",
) {
    /** The `selectedModel` storage key the shared extension JS dispatches on. */
    val selectedModelKey: String get() = "iosLocal:$id"

    val supportsDetection: Boolean get() = adapterFilename != null && adapterUrl != null && headAssetName != null

    fun isSupportedOn(context: Context): Boolean {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val info = ActivityManager.MemoryInfo()
        am.getMemoryInfo(info)
        return info.totalMem >= minimumRamBytes
    }
}

object LocalModels {
    val models: List<LocalModel> = listOf(
        LocalModel(
            id = "gemma-4-e2b-detector-v2",
            displayName = "Gemma E2B",
            url = "https://huggingface.co/DarrenJiaImbue/gemma-4-e2b-ai-text-detector-v2/resolve/main/model.litertlm",
            filename = "model-e2b-detector-v2.litertlm",
            cacheSubdir = "detector_e2b_v2_gpu_v1",
            approxSize = "~2.2 GB",
            approxSizeBytes = 2_360_000_000L,
            adapterFilename = "lora_adapter-e2b-detector-v2.tflite",
            adapterUrl = "https://huggingface.co/DarrenJiaImbue/gemma-4-e2b-ai-text-detector-v2/resolve/main/lora_adapter.tflite",
            headAssetName = "detector_head_e2b_v2.bin",
        )
    )

    fun forId(id: String): LocalModel? = models.firstOrNull { it.id == id }

    fun forKey(key: String): LocalModel? {
        if (!key.startsWith("iosLocal:")) return null
        return forId(key.removePrefix("iosLocal:"))
    }
}
