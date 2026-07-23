package com.imbue.bouncer.web

import android.util.Base64
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

class WebSocketBridge(
    private val userId: () -> String,
    private val appCheck: AppCheckBridge,
    private val scope: CoroutineScope,
    private val postToPage: (JSONObject) -> Unit,
) {
    private val tag = "WebSocketBridge"
    private val client = OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .build()
    private val sockets = ConcurrentHashMap<String, WebSocket>()
    private val origin = "chrome-extension://bkijmhafoocfloemhancbgadknkgdkcm"

    fun open(json: String) {
        val obj = runCatching { JSONObject(json) }.getOrNull() ?: return
        val socketId = obj.optString("socketId").takeIf { it.isNotEmpty() } ?: return
        val rawUrl = obj.optString("url")
        scope.launch {
            val token = appCheck.currentToken().orEmpty()
            val url = appendParams(rawUrl, userId(), token)
            val request = Request.Builder()
                .url(url)
                .header("Origin", origin)
                .build()
            Log.d(tag, "open $socketId -> ${redact(url)}")
            val ws = client.newWebSocket(request, listenerFor(socketId))
            sockets[socketId] = ws
        }
    }

    fun send(json: String) {
        val obj = runCatching { JSONObject(json) }.getOrNull() ?: return
        val socketId = obj.optString("socketId").takeIf { it.isNotEmpty() } ?: return
        val data = obj.optString("data")
        sockets[socketId]?.send(data)
    }

    fun close(json: String) {
        val obj = runCatching { JSONObject(json) }.getOrNull() ?: return
        val socketId = obj.optString("socketId").takeIf { it.isNotEmpty() } ?: return
        Log.d(tag, "close $socketId")
        sockets.remove(socketId)?.close(1000, null)
    }

    private fun appendParams(rawUrl: String, userId: String, token: String): String {
        // OkHttp's HttpUrl parser only accepts http/https; swap wss→https around the rewrite.
        val (httpForm, restore) = when {
            rawUrl.startsWith("wss://") -> "https://" + rawUrl.removePrefix("wss://") to { s: String ->
                "wss://" + s.removePrefix("https://")
            }
            rawUrl.startsWith("ws://") -> "http://" + rawUrl.removePrefix("ws://") to { s: String ->
                "ws://" + s.removePrefix("http://")
            }
            else -> rawUrl to { s: String -> s }
        }
        val parsed = httpForm.toHttpUrlOrNull() ?: return rawUrl
        val builder = parsed.newBuilder()
            .removeAllQueryParameters("user_id")
            .addQueryParameter("user_id", userId)
        if (token.isNotBlank()) {
            builder.removeAllQueryParameters("token_ios").addQueryParameter("token_ios", token)
        }
        return restore(builder.build().toString())
    }

    private fun redact(url: String): String {
        val idx = url.indexOf("token_ios=")
        if (idx < 0) return url
        val end = url.indexOf('&', idx).let { if (it < 0) url.length else it }
        return url.substring(0, idx) + "token_ios=…(${end - idx - 10} chars)" + url.substring(end)
    }

    private fun listenerFor(socketId: String) = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            Log.d(tag, "onOpen $socketId")
            fireEvent(socketId, "open", null)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            fireMessage(socketId, text.toByteArray())
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            fireMessage(socketId, bytes.toByteArray())
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            Log.d(tag, "onClosing $socketId code=$code reason=$reason")
            val data = JSONObject().apply {
                put("code", code)
                put("wasClean", true)
            }
            fireEvent(socketId, "close", data)
            sockets.remove(socketId)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            sockets.remove(socketId)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            val code = response?.code ?: -1
            Log.w(tag, "onFailure $socketId code=$code", t)
            if (code == 401 || code == 403) {
                appCheck.invalidate()
            }
            fireEvent(socketId, "error", null)
            val data = JSONObject().apply {
                put("code", 1006)
                put("wasClean", false)
            }
            fireEvent(socketId, "close", data)
            sockets.remove(socketId)
        }
    }

    private fun fireMessage(socketId: String, bytes: ByteArray) {
        val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
        val payload = JSONObject().apply {
            put("kind", "wsMessage")
            put("socketId", socketId)
            put("b64", b64)
        }
        postToPage(payload)
    }

    private fun fireEvent(socketId: String, event: String, data: JSONObject?) {
        val payload = JSONObject().apply {
            put("kind", "wsEvent")
            put("socketId", socketId)
            put("event", event)
            put("data", data ?: JSONObject.NULL)
        }
        postToPage(payload)
    }
}
