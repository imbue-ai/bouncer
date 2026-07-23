package com.imbue.bouncer.state

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.imbue.bouncer.web.GeckoBridge
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.mozilla.geckoview.GeckoSession

class BouncerViewModel(app: Application) : AndroidViewModel(app) {
    private val tag = "BouncerVM"

    private val prefs: SharedPreferences =
        app.getSharedPreferences("bouncer_prefs", Context.MODE_PRIVATE)

    private var session: GeckoSession? = null
    private var bridge: GeckoBridge? = null
    private var aiSettingsLoaded = false
    private var popupSessionRef: GeckoSession? = null
    @Volatile private var savedState: GeckoSession.SessionState? = null

    // Filter-pack share is async: if the WebView isn't already on x.com we
    // navigate there first and fire the JS once the page settles. The deadline
    // job clears the pending flag so we don't fire late if the load stalls.
    private var pendingShareFilterPack = false
    private var pendingShareTimeoutJob: Job? = null

    // Scroll-driven nav bar visibility. lastScrollY is the page's last reported
    // Y. accumulatedDown/Up integrate single-direction motion so a slow scroll
    // still trips the threshold instead of dying to per-event jitter.
    private var lastScrollY = 0
    private var accumulatedDown = 0
    private var accumulatedUp = 0

    private val _state = MutableStateFlow(
        BouncerUiState(
            hasCompletedOnboarding = prefs.getBoolean(KEY_ONBOARDED, false),
            hasLoggedIn = prefs.getBoolean(KEY_LOGGED_IN, false),
            hasSeenBouncerTooltip = prefs.getBoolean(KEY_BOUNCER_TOOLTIP_SEEN, false),
        )
    )
    val state: StateFlow<BouncerUiState> = _state.asStateFlow()

    fun initialUrl(): String =
        if (_state.value.hasLoggedIn) "https://x.com" else "https://x.com/i/flow/login"

    fun currentUrlOrInitial(): String =
        _state.value.currentUrl.ifEmpty { initialUrl() }

    val savedSessionState: GeckoSession.SessionState?
        get() = savedState

    fun onSessionStateChanged(state: GeckoSession.SessionState) {
        savedState = state
    }

    fun attachSession(s: GeckoSession) {
        session = s
    }

    fun mainSession(): GeckoSession? = session

    fun attachBridge(b: GeckoBridge) {
        bridge = b
        b.attach(this)
    }

    fun popupSession(): GeckoSession? = popupSessionRef

    fun attachPopupSession(s: GeckoSession) {
        popupSessionRef?.close()
        popupSessionRef = s
        _state.update { it.copy(popupActive = true) }
    }

    fun closePopup() {
        popupSessionRef?.close()
        popupSessionRef = null
        _state.update { it.copy(popupActive = false) }
    }

    fun setSessionActive(active: Boolean) {
        session?.setActive(active)
        popupSessionRef?.setActive(active)
    }

    // Returning to the app should always surface the nav bar — otherwise a
    // scrolled-down state from a prior session combined with a GeckoView that
    // briefly paints black on resume leaves the user with nothing to tap.
    fun onAppForegrounded() {
        lastScrollY = 0
        accumulatedDown = 0
        accumulatedUp = 0
        if (!_state.value.navBarVisible) {
            _state.update { it.copy(navBarVisible = true) }
        }
    }

    // ----- JS → native (called on Main) -----

    fun onShowSheet(json: String) {
        applyPhrasesJson(json)
        _state.update { it.copy(isSheetPresented = !it.isSheetPresented) }
    }

    fun onPhrasesUpdated(json: String) {
        applyPhrasesJson(json)
    }

    fun onModalClosed() {
        _state.update { it.copy(isFilteredModalOpen = false) }
    }

    fun onUrlChanged(url: String) {
        _state.update { it.copy(currentUrl = url) }
        if (!_state.value.hasLoggedIn && (url.contains("x.com/home") || url.contains("twitter.com/home"))) {
            prefs.edit().putBoolean(KEY_LOGGED_IN, true).apply()
            _state.update { it.copy(hasLoggedIn = true) }
        }
    }

    fun setCanGoBack(canGoBack: Boolean) {
        _state.update { it.copy(canGoBack = canGoBack) }
    }

    fun setCanGoForward(canGoForward: Boolean) {
        _state.update { it.copy(canGoForward = canGoForward) }
    }

    fun onPageStop() {
        maybeLoadAiSettings()
        if (pendingShareFilterPack && isOnX(_state.value.currentUrl)) {
            pendingShareFilterPack = false
            pendingShareTimeoutJob?.cancel()
            pendingShareTimeoutJob = null
            callJs("__ff_shareFilterPack")
        }
    }

    fun onScroll(scrollY: Int) {
        if (scrollY < TOP_PIN_PX) {
            lastScrollY = scrollY
            accumulatedDown = 0
            accumulatedUp = 0
            setNavBarVisible(true)
            return
        }
        val delta = scrollY - lastScrollY
        lastScrollY = scrollY
        when {
            delta > 0 -> {
                accumulatedDown += delta
                accumulatedUp = 0
                if (accumulatedDown > HIDE_THRESHOLD_PX) setNavBarVisible(false)
            }
            delta < 0 -> {
                accumulatedUp += -delta
                accumulatedDown = 0
                if (accumulatedUp > SHOW_THRESHOLD_PX) setNavBarVisible(true)
            }
        }
    }

    private fun setNavBarVisible(visible: Boolean) {
        if (_state.value.navBarVisible != visible) {
            _state.update { it.copy(navBarVisible = visible) }
        }
    }

    private fun applyPhrasesJson(json: String) {
        val obj = runCatching { JSONObject(json) }.getOrElse {
            Log.w(tag, "Bad phrases JSON: $json")
            return
        }
        val phrases = obj.optJSONArray("phrases")?.let { arr ->
            buildList { for (i in 0 until arr.length()) add(arr.optString(i)) }
        }
        val count = if (obj.has("filteredCount")) obj.optInt("filteredCount", 0) else null
        val theme = obj.optString("theme").takeIf { it.isNotEmpty() }
        _state.update { s ->
            s.copy(
                phrases = phrases ?: s.phrases,
                filteredCount = count ?: s.filteredCount,
                themeMode = theme ?: s.themeMode,
            )
        }
    }

    // ----- UI → JS -----

    fun setSheetPresented(open: Boolean) {
        _state.update { it.copy(isSheetPresented = open) }
        callJs("__ff_setSheetClass", open)
    }

    fun completeOnboarding() {
        prefs.edit().putBoolean(KEY_ONBOARDED, true).apply()
        _state.update { it.copy(hasCompletedOnboarding = true) }
    }

    fun markBouncerTooltipSeen() {
        if (_state.value.hasSeenBouncerTooltip) return
        prefs.edit().putBoolean(KEY_BOUNCER_TOOLTIP_SEEN, true).apply()
        _state.update { it.copy(hasSeenBouncerTooltip = true) }
    }

    fun addPhrase(text: String) {
        callJs("__ff_addPhrase", text)
    }

    fun removePhrase(phrase: String) {
        _state.update { s -> s.copy(phrases = s.phrases.filter { it != phrase }) }
        callJs("__ff_removePhrase", phrase)
    }

    fun openFilteredModal() {
        _state.update {
            it.copy(
                isFilteredModalOpen = true,
                isSheetPresented = false,
                navBarVisible = false,
            )
        }
        callJs("__ff_setSheetClass", false)
        callJs("__ff_showFilteredModal")
    }

    // The compiled content script that defines window.__ff_shareFilterPack is
    // only injected on x.com / twitter.com pages, so we navigate there first
    // and fire the JS once the load settles.
    fun shareFilterPack() {
        setSheetPresented(false)
        if (isOnX(_state.value.currentUrl)) {
            callJs("__ff_shareFilterPack")
            return
        }
        pendingShareTimeoutJob?.cancel()
        pendingShareFilterPack = true
        pendingShareTimeoutJob = viewModelScope.launch {
            delay(SHARE_LOAD_DEADLINE_MS)
            pendingShareFilterPack = false
            pendingShareTimeoutJob = null
        }
        navigateTo("https://x.com/home")
    }

    private fun isOnX(url: String): Boolean {
        val host = runCatching { Uri.parse(url).host?.lowercase() }.getOrNull().orEmpty()
        return host == "x.com" || host.endsWith(".x.com") ||
            host == "twitter.com" || host.endsWith(".twitter.com")
    }

    fun setAiTextFilterEnabled(enabled: Boolean) {
        _state.update { it.copy(aiTextFilterEnabled = enabled) }
        callJs("__ff_setAiTextFilterEnabled", enabled)
    }

    fun setAiTextDetectionThreshold(value: Double) {
        val clamped = value.coerceIn(0.0, 1.0)
        _state.update { it.copy(aiTextDetectionThreshold = clamped) }
        callJs("__ff_setAiTextDetectionThreshold", clamped)
    }

    fun goBack() {
        session?.goBack()
    }

    fun goForward() {
        session?.goForward()
    }

    fun reload() {
        session?.reload()
    }

    fun navigateTo(url: String) {
        val normalized = if (url.contains("://")) url else "https://$url"
        session?.loadUri(normalized)
    }

    fun onAiSettingsReply(json: String) {
        val obj = runCatching { JSONObject(json) }.getOrElse { return }
        _state.update { s ->
            s.copy(
                aiTextFilterEnabled = if (obj.has("aiTextFilterEnabled")) obj.optBoolean("aiTextFilterEnabled") else s.aiTextFilterEnabled,
                aiTextDetectionThreshold = if (obj.has("aiTextDetectionThreshold")) obj.optDouble("aiTextDetectionThreshold", s.aiTextDetectionThreshold) else s.aiTextDetectionThreshold,
            )
        }
    }

    private fun maybeLoadAiSettings() {
        if (aiSettingsLoaded) return
        aiSettingsLoaded = true
        callJs("__ff_loadAiSettings")
    }

    private fun callJs(fn: String, vararg args: Any?) {
        bridge?.callJs(fn, *args)
    }

    companion object {
        private const val KEY_ONBOARDED = "hasCompletedOnboarding"
        private const val KEY_LOGGED_IN = "hasLoggedIn"
        private const val KEY_BOUNCER_TOOLTIP_SEEN = "hasSeenBouncerTooltip"
        private const val TOP_PIN_PX = 80
        private const val HIDE_THRESHOLD_PX = 24
        private const val SHOW_THRESHOLD_PX = 16
        private const val SHARE_LOAD_DEADLINE_MS = 8_000L
    }
}
