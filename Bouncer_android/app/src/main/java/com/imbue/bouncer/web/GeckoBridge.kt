package com.imbue.bouncer.web

import android.content.Context
import android.util.Log
import com.imbue.bouncer.state.BouncerViewModel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import org.mozilla.geckoview.WebExtension

class GeckoBridge(
    appCtx: Context,
    private val scope: CoroutineScope,
    private val appCheck: AppCheckBridge,
) : WebExtension.MessageDelegate {

    private val tag = "FF/Bridge"

    @Volatile private var port: WebExtension.Port? = null

    // VM is attached after construction so the bridge can be created during
    // Application warmup (before any ViewModel exists) and re-pointed at the
    // current VM each time an activity (re)creates.
    @Volatile private var vm: BouncerViewModel? = null

    fun attach(vm: BouncerViewModel) {
        this.vm = vm
    }

    private val ws = WebSocketBridge(
        userId = { UserId.get(appCtx) },
        appCheck = appCheck,
        scope = scope,
        postToPage = { payload -> postToPage(payload) },
    )

    private val portDelegate = object : WebExtension.PortDelegate {
        override fun onPortMessage(message: Any, port: WebExtension.Port) {
            handleMessage(message)
        }

        override fun onDisconnect(port: WebExtension.Port) {
            if (this@GeckoBridge.port === port) {
                this@GeckoBridge.port = null
            }
        }
    }

    override fun onConnect(port: WebExtension.Port) {
        Log.i(tag, "port connected: ${port.name}")
        this.port = port
        port.setDelegate(portDelegate)
    }

    fun postToPage(payload: JSONObject) {
        val p = port ?: return
        scope.launch(Dispatchers.Main) {
            runCatching { p.postMessage(payload) }
                .onFailure { Log.w(tag, "postToPage failed", it) }
        }
    }

    fun callJs(fn: String, vararg args: Any?) {
        val argArray = JSONArray().apply {
            args.forEach { put(it ?: JSONObject.NULL) }
        }
        val payload = JSONObject().apply {
            put("kind", "call")
            put("fn", fn)
            put("args", argArray)
        }
        postToPage(payload)
    }

    private fun handleMessage(message: Any) {
        val obj = message as? JSONObject ?: run {
            Log.w(tag, "non-JSON port message: ${message.javaClass.simpleName}")
            return
        }
        if (obj.optString("kind") != "bridge") return
        val name = obj.optString("name")
        val arg = obj.optString("arg")
        // ws.* messages are VM-independent — handle them even before a VM is attached.
        when (name) {
            "feedfilterLog" -> { Log.d("FF/JS", arg); return }
            "feedfilterWsOpen" -> { ws.open(arg); return }
            "feedfilterWsSend" -> { ws.send(arg); return }
            "feedfilterWsClose" -> { ws.close(arg); return }
        }
        val v = vm ?: run {
            Log.w(tag, "no VM attached; dropping $name")
            return
        }
        when (name) {
            "feedfilterShowSheet" -> scope.launch(Dispatchers.Main) { v.onShowSheet(arg) }
            "feedfilterPhrasesUpdated" -> scope.launch(Dispatchers.Main) { v.onPhrasesUpdated(arg) }
            "feedfilterModalClosed" -> scope.launch(Dispatchers.Main) { v.onModalClosed() }
            "feedfilterAiSettings" -> scope.launch(Dispatchers.Main) { v.onAiSettingsReply(arg) }
            "feedfilterPushDirectResult" -> scope.launch(Dispatchers.Main) { v.onPushDirectResult(arg) }
            else -> Log.w(tag, "unknown bridge message: $name")
        }
    }
}
