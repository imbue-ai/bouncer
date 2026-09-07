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

    // GeckoView delivers a single native port, owned by the extension's
    // background page (background.js), which fans messages out to every tab's
    // content script. Per-tab routing therefore lives in background.js: outbound
    // UI calls carry an "__ffTarget" platform so the background sends them only
    // to the visible tab, and inbound messages are stamped "__ffPlatform" so we
    // can attribute them to the right feed.
    @Volatile private var port: WebExtension.Port? = null
    @Volatile private var activePlatform: String? = null

    fun setActivePlatform(platformId: String) {
        activePlatform = platformId
    }

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
            if (this@GeckoBridge.port === port) this@GeckoBridge.port = null
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

    // UI-driven calls are tagged with the active platform so background.js
    // delivers them only to the visible tab (not warm background tabs). ws /
    // appcheck responses go through postToPage untagged and are broadcast +
    // routed by socket/callback id, so they still reach the tab that asked.
    fun callJs(fn: String, vararg args: Any?) {
        val argArray = JSONArray().apply {
            args.forEach { put(it ?: JSONObject.NULL) }
        }
        val payload = JSONObject().apply {
            put("kind", "call")
            put("fn", fn)
            put("args", argArray)
            activePlatform?.let { put("__ffTarget", it) }
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
        // background.js stamps the originating tab's platform here.
        val fromPlatform = obj.optString("__ffPlatform").takeIf { it.isNotEmpty() }
        // ws.* messages are VM-independent and per-socket — handle for any tab,
        // even before a VM is attached.
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
        // A message counts as "active" only if it came from the visible tab, so
        // a warm background tab can't drive the shared UI. (Unknown origin →
        // treat as active for backwards-compat with the single-tab case.)
        val fromActive = fromPlatform == null || activePlatform == null || fromPlatform == activePlatform
        when (name) {
            // Phrase/count pushes are attributed to the tab's platform so each
            // feed keeps its own phrases + filtered count.
            "feedfilterPhrasesUpdated" -> scope.launch(Dispatchers.Main) { v.onPhrasesUpdated(fromPlatform, arg) }
            "feedfilterShowSheet" -> if (fromActive) scope.launch(Dispatchers.Main) { v.onShowSheet(arg) }
            "feedfilterModalClosed" -> if (fromActive) scope.launch(Dispatchers.Main) { v.onModalClosed() }
            "feedfilterAiSettings" -> if (fromActive) scope.launch(Dispatchers.Main) { v.onAiSettingsReply(arg) }
            // Comes from the HIDDEN auto-enable tab (see BouncerGeckoView.preloadPushSettings),
            // so it's intentionally NOT gated on fromActive — it signals the
            // off-screen settings page rendered its toggle, carrying its current
            // on/off state so the VM knows whether a click is even needed.
            "feedfilterPushToggleReady" -> {
                val alreadyOn = runCatching { JSONObject(arg).optBoolean("checked") }.getOrDefault(false)
                scope.launch(Dispatchers.Main) { v.onPushSettingsReady(alreadyOn) }
            }
            else -> Log.w(tag, "unknown bridge message: $name")
        }
    }
}
