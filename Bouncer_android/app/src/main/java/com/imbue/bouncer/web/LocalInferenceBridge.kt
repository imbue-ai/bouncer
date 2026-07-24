package com.imbue.bouncer.web

import android.util.Base64
import android.util.Log
import com.imbue.bouncer.inference.LocalInferenceService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * Bridges `feedfilterLocalClassify` / `feedfilterLocalAiTextDetect` messages from the
 * extension JS to [LocalInferenceService], mirroring the iOS handlers in
 * FilteredWebView.swift. Results are delivered back through the JS resolver
 * callbacks (`__ff_resolveLocalClassify` / `__ff_resolveLocalAiTextDetect`) with a
 * base64-encoded UTF-8 payload: the raw model output (or error string) for classify,
 * and a `{"logits":[...],"aiConfidence":n}` JSON object for detection.
 */
class LocalInferenceBridge(
    private val service: LocalInferenceService,
    private val scope: CoroutineScope,
    private val callJs: (fn: String, args: Array<Any?>) -> Unit,
) {
    private val tag = "FF/LocalInference"

    fun handleClassify(arg: String) {
        val json = runCatching { JSONObject(arg) }.getOrNull() ?: return logParseFail("classify")
        val callbackId = json.optString("callbackId").takeIf { it.isNotEmpty() }
            ?: return logParseFail("classify")
        val systemMessage = json.optString("systemMessage")
        val userMessage = json.optString("userMessage")
        val regexConstraint = optNonEmptyString(json, "regexConstraint")
        val modelName = optNonEmptyString(json, "modelName")
        val maxOutputTokens = if (json.has("maxOutputTokens")) json.optInt("maxOutputTokens") else null
        val imageUrls = json.optJSONArray("imageUrls")?.let { a ->
            List(a.length()) { a.optString(it) }.filter { it.isNotEmpty() }
        } ?: emptyList()

        scope.launch(Dispatchers.Default) {
            try {
                val response = service.classify(
                    systemMessage = systemMessage,
                    userMessage = userMessage,
                    imageUrls = imageUrls,
                    regexConstraint = regexConstraint,
                    modelName = modelName,
                    maxOutputTokens = maxOutputTokens,
                )
                resolve("__ff_resolveLocalClassify", callbackId, ok = true, payload = response)
            } catch (t: Throwable) {
                Log.w(tag, "classify failed", t)
                resolve(
                    "__ff_resolveLocalClassify", callbackId, ok = false,
                    payload = errorPayload(t, "sysLen=${systemMessage.length} userLen=${userMessage.length}"),
                )
            }
        }
    }

    fun handleAiTextDetect(arg: String) {
        val json = runCatching { JSONObject(arg) }.getOrNull() ?: return logParseFail("detect")
        val callbackId = json.optString("callbackId").takeIf { it.isNotEmpty() }
            ?: return logParseFail("detect")
        val text = json.optString("text")

        scope.launch(Dispatchers.Default) {
            try {
                val result = service.detectAIText(text)
                val payload = JSONObject().apply {
                    put("logits", JSONArray().apply { result.logits.forEach { put(it.toDouble()) } })
                    put("aiConfidence", result.aiConfidence.toDouble())
                }
                resolve("__ff_resolveLocalAiTextDetect", callbackId, ok = true, payload = payload.toString())
            } catch (t: Throwable) {
                Log.w(tag, "detect failed", t)
                resolve(
                    "__ff_resolveLocalAiTextDetect", callbackId, ok = false,
                    payload = errorPayload(t, "textLen=${text.length}"),
                )
            }
        }
    }

    private fun resolve(fn: String, callbackId: String, ok: Boolean, payload: String) {
        val b64 = Base64.encodeToString(payload.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
        callJs(fn, arrayOf(callbackId, ok, b64))
    }

    private fun errorPayload(t: Throwable, context: String): String =
        "${t.javaClass.simpleName}: ${t.message ?: "unknown"} | $context"

    private fun optNonEmptyString(json: JSONObject, key: String): String? =
        if (json.has(key) && !json.isNull(key)) json.optString(key).takeIf { it.isNotEmpty() } else null

    private fun logParseFail(what: String) {
        Log.w(tag, "dropping malformed $what payload")
    }
}
