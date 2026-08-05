package com.imbue.bouncer.state

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.imbue.bouncer.push.NotificationPermissionBroker
import com.imbue.bouncer.push.PushRegistrar
import com.imbue.bouncer.push.PushSubscriptionStore
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

    // Enable-notifications flow: set while the user is on x.com's push-settings
    // page being coached to tap the real toggle. Cleared when the subscription
    // registers (→ home) or the user navigates away.
    private var pendingPushToggle = false

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
        // The login/signup flow is proof we're NOT authenticated. hasLoggedIn is
        // a sticky pref (and survives Auto Backup across reinstalls), so it can
        // be stale-true after a logout or a restore; correct it here so the
        // tooltip and notifications prompt don't fire on the logged-out screen.
        if (_state.value.hasLoggedIn && isLoginFlow(url)) {
            prefs.edit().putBoolean(KEY_LOGGED_IN, false).apply()
            _state.update { it.copy(hasLoggedIn = false) }
        }
        if (isHome(url) && !_state.value.reachedTimeline) {
            _state.update { it.copy(reachedTimeline = true) }
        }
        if (!_state.value.hasLoggedIn && isHome(url)) {
            prefs.edit().putBoolean(KEY_LOGGED_IN, true).apply()
            _state.update { it.copy(hasLoggedIn = true) }
            maybePromptEnableNotifications()
        }
    }

    // ----- Enable-notifications flow -----

    // Offer to turn on x.com push notifications. Shown once per install (a
    // decline or completion sets the flag), triggered either on a fresh login
    // (onUrlChanged) or, for users who are already logged in at launch
    // (returning users, backup-restored state), once the timeline settles
    // (onPageStop). Skipped if a subscription already exists.
    private var notifPromptEvaluated = false

    private fun maybePromptEnableNotifications() {
        if (notifPromptEvaluated) return
        if (prefs.getBoolean(KEY_NOTIF_PROMPTED, false)) { notifPromptEvaluated = true; return }
        if (pendingPushToggle || _state.value.enablingNotifications) return
        notifPromptEvaluated = true
        // Don't nag someone who already turned notifications on.
        val alreadySubscribed = runCatching {
            PushSubscriptionStore(getApplication()).get("https://x.com/") != null
        }.getOrDefault(false)
        if (alreadySubscribed) {
            prefs.edit().putBoolean(KEY_NOTIF_PROMPTED, true).apply()
            return
        }
        _state.update { it.copy(showEnableNotificationsPrompt = true) }
    }

    fun dismissEnableNotificationsPrompt() {
        prefs.edit().putBoolean(KEY_NOTIF_PROMPTED, true).apply()
        _state.update { it.copy(showEnableNotificationsPrompt = false) }
    }

    // User accepted. Option #4: instead of sending them to the slow settings
    // page, inject an in-page button on the current (home) page. Their tap on
    // it is a genuine user gesture, so pushManager.subscribe() is allowed —
    // that registers our FCM endpoint, and (iteration 1) x.com's own client
    // then syncs the subscription to its backend when we visit settings.
    fun acceptEnableNotifications() {
        prefs.edit().putBoolean(KEY_NOTIF_PROMPTED, true).apply()
        pendingPushToggle = true
        _state.update {
            it.copy(showEnableNotificationsPrompt = false, enablingNotifications = true)
        }
        // Grant the Android POST_NOTIFICATIONS runtime permission up front (this
        // native tap is a valid gesture for it), so the in-page subscribe flows
        // straight through our permission delegate without a second stop.
        NotificationPermissionBroker.ensurePermission(getApplication()) { granted ->
            Log.i(tag, "POST_NOTIFICATIONS granted=$granted")
        }
        callJs("__ff_showEnablePushButton")
    }

    // bridge_page.js reports the in-page subscribe result. On success it
    // navigates itself to the settings page to let x.com sync; we just clear
    // the banner and let the flow settle.
    fun onPushDirectResult(json: String) {
        val obj = runCatching { JSONObject(json) }.getOrNull()
        val ok = obj?.optBoolean("ok", false) ?: false
        Log.i(tag, "push direct result: ok=$ok stage=${obj?.optString("stage")} detail=${obj?.optString("detail")}")
        pendingPushToggle = false
        _state.update { it.copy(enablingNotifications = false) }
    }

    fun cancelEnableNotifications() {
        if (!pendingPushToggle) return
        pendingPushToggle = false
        _state.update { it.copy(enablingNotifications = false) }
    }

    private fun isPushSettings(url: String): Boolean =
        url.contains("x.com/settings/push_notifications") ||
            url.contains("twitter.com/settings/push_notifications")

    private fun isHome(url: String): Boolean =
        url.contains("x.com/home") || url.contains("twitter.com/home")

    // The unauthenticated login/signup flow (initialUrl for logged-out users is
    // x.com/i/flow/login). Kept narrow so ordinary /i/flow/ dialogs that a
    // logged-in user might hit don't trip a false logout.
    private fun isLoginFlow(url: String): Boolean =
        url.contains("/i/flow/login") ||
            url.contains("/i/flow/signup") ||
            url.contains("x.com/login") ||
            url.contains("twitter.com/login") ||
            url.contains("/logout") ||
            url.contains("/account/access")

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
        val url = _state.value.currentUrl
        if (_state.value.hasLoggedIn && isHome(url)) {
            // Users already logged in at launch (returning / backup-restored
            // state) never hit the login transition; the authenticated timeline
            // (/home) is the signal to evaluate the one-time prompt for them.
            maybePromptEnableNotifications()
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
        // `aiDetectionConfirmed` is true only for pushes triggered by an
        // aiFilterIntent storage write — the same signal that clears the
        // desktop indicator's `.pending` class — so unrelated pushes (phrase
        // edits, filtered-count changes) can't clear the pending dim early
        // while the backend is still judging the seed phrase.
        val aiConfirmed = obj.optBoolean("aiDetectionConfirmed", false)
        if (aiConfirmed) {
            aiPendingFallbackJob?.cancel()
            aiPendingFallbackJob = null
        }
        _state.update { s ->
            s.copy(
                phrases = phrases ?: s.phrases,
                filteredCount = count ?: s.filteredCount,
                themeMode = theme ?: s.themeMode,
                aiDetectionOn = if (obj.has("aiDetectionOn")) obj.optBoolean("aiDetectionOn") else s.aiDetectionOn,
                aiDetectionPending = if (aiConfirmed) false else s.aiDetectionPending,
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

    private var aiPendingFallbackJob: Job? = null

    // Toggle AI detection through the natural-language phrase mechanism —
    // the sparkle indicator's tap action, mirroring the iOS sheet and the
    // desktop indicator (toggleAiDetectionViaPhrases in content/ui.ts).
    // Off→on adds the seed phrase "AI slop" and waits for the backend to
    // judge it; on→off deletes every AI phrase (instant, no round trip).
    // Confirmation arrives via the feedfilterPhrasesUpdated push
    // (applyPhrasesJson); the fallback timer keeps a dropped round trip
    // from wedging the indicator.
    fun toggleAiDetection() {
        _state.update { it.copy(aiDetectionPending = true) }
        aiPendingFallbackJob?.cancel()
        aiPendingFallbackJob = viewModelScope.launch {
            delay(AI_PENDING_FALLBACK_MS)
            _state.update { it.copy(aiDetectionPending = false) }
            callJs("__ff_loadAiSettings")
        }
        callJs("__ff_toggleAiDetection")
    }

    // Same storage key the JS pipeline reads (`filterReplies`); the content
    // script's storage.onChanged listener applies it live, including
    // un-hiding already-filtered replies when turned off.
    fun setFilterReplies(enabled: Boolean) {
        _state.update { it.copy(filterReplies = enabled) }
        callJs("__ff_setStorage", JSONObject().put("filterReplies", enabled))
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
                aiDetectionOn = if (obj.has("aiDetectionOn")) obj.optBoolean("aiDetectionOn") else s.aiDetectionOn,
                filterReplies = if (obj.has("filterReplies")) obj.optBoolean("filterReplies", s.filterReplies) else s.filterReplies,
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
        private const val KEY_NOTIF_PROMPTED = "hasPromptedNotifications"
        private const val PUSH_SETTINGS_URL = "https://x.com/settings/push_notifications"
        // Grace after the subscription registers, for the site to POST its
        // endpoint to its own server before we navigate away.
        private const val PUSH_REGISTER_GRACE_MS = 1_500L
        private const val TOP_PIN_PX = 80
        private const val HIDE_THRESHOLD_PX = 24
        private const val SHOW_THRESHOLD_PX = 16
        private const val SHARE_LOAD_DEADLINE_MS = 8_000L
        // Matches the iOS sheet's 10s aiPendingFallbackTask.
        private const val AI_PENDING_FALLBACK_MS = 10_000L
    }
}
