package com.imbue.bouncer.state

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.util.Log
import android.widget.Toast
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.imbue.bouncer.push.NotificationPermissionBroker
import com.imbue.bouncer.push.PushRegistrar
import com.imbue.bouncer.push.PushSubscriptionStore
import com.imbue.bouncer.push.WebNotificationHandler
import com.imbue.bouncer.web.BouncerGeckoView
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

    // Each platform is a live tab (see BouncerGeckoView), so its filter phrases,
    // filtered count and last URL live in their own slot — mirroring iOS's
    // per-platform WebViewCache/filteredCounts. The displayed state (phrases /
    // filteredCount / currentUrl in _state) always reflects the active tab.
    private var activePlatformId: String = "twitter"
    private val phrasesByPlatform = mutableMapOf<String, List<String>>()
    private val countByPlatform = mutableMapOf<String, Int>()
    private val urlByPlatform = mutableMapOf<String, String>()

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
            // The settings toggle's state: the persisted display preference,
            // defaulting to whether a subscription already exists (so pre-existing
            // subscribers show "on").
            notificationsEnabled = run {
                val subscribed = runCatching {
                    PushSubscriptionStore(app).get("https://x.com/") != null
                }.getOrDefault(false)
                prefs.getBoolean(WebNotificationHandler.KEY_NOTIFICATIONS_ON, subscribed)
            },
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
        // Recover an auto-enable that got cut off (e.g. the screen slept during
        // the ~30s off-screen render) by re-attempting now that we're foreground.
        maybeRetryPushEnable()
    }

    // ----- JS → native (called on Main) -----

    fun onShowSheet(json: String) {
        applyPhrasesJson(null, json)
        _state.update { it.copy(isSheetPresented = !it.isSheetPresented) }
    }

    // platformId identifies which tab pushed this (null = the active tab). The
    // phrases/count land in that platform's slot; only the active platform's
    // slot is mirrored into the visible UI.
    fun onPhrasesUpdated(platformId: String?, json: String) {
        applyPhrasesJson(platformId, json)
    }

    // BouncerGeckoView calls this after swapping the visible tab: reflect the
    // newly-active platform's cached phrases/count/URL immediately (so the sheet
    // and badge are correct at once, like iOS), and re-pull its AI settings.
    fun onPlatformSwitched(platformId: String) {
        activePlatformId = platformId
        _state.update {
            it.copy(
                phrases = phrasesByPlatform[platformId] ?: emptyList(),
                filteredCount = countByPlatform[platformId] ?: 0,
                currentUrl = urlByPlatform[platformId] ?: it.currentUrl,
            )
        }
        callJs("__ff_loadAiSettings")
    }

    fun onModalClosed() {
        _state.update { it.copy(isFilteredModalOpen = false) }
    }

    fun onUrlChanged(url: String) {
        _state.update { it.copy(currentUrl = url) }
        // onUrlChanged is only delivered for the active tab (gated in the
        // session delegate), so this records the visible platform's URL.
        urlByPlatform[activePlatformId] = url
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
        }
        // Evaluate the one-time prompt whenever we're on the home timeline —
        // x.com's logged-in landing loads "x.com/" then SPA-routes to "/home"
        // without a fresh onPageStop, so keying only on onPageStop missed it.
        // onLocationChange fires on that pushState route, and maybePrompt is
        // idempotent (guarded by notifPromptEvaluated + the persisted flag).
        if (_state.value.hasLoggedIn && isHome(url)) {
            maybeAutoEnablePush()
        }
    }

    // ----- Silent push auto-enable -----

    // Turn on x.com push notifications automatically, with zero UI. Attempted
    // once per install (persisted flag), triggered either on a fresh login
    // (onUrlChanged) or, for users already logged in at launch, once the timeline
    // settles (onPageStop). Skipped if a subscription already exists.
    //
    // Mechanism: load x.com's push-settings page in a HIDDEN tab (shares cookies,
    // so already logged in), wait for its toggle to render (onPushSettingsReady),
    // then have JS click that toggle in place (__ff_autoEnablePush). x.com's own
    // handler does the subscribe AND the backend registration — the combination
    // that actually delivers pushes. Our WebPushDelegate captures the endpoint;
    // once PushRegistrar reports it, we tear the hidden tab down. The user sees
    // nothing and waits for nothing; the only surface is the Android
    // notification-permission dialog (NotificationPermissionBroker), which we
    // can't self-grant and which gates delivery anyway.
    // Guards the once-per-session evaluation of the silent push auto-enable.
    private var pushEnableEvaluated = false

    private var awaitingPushPreload = false
    private var pushPreloadFallbackJob: Job? = null

    // Set while an auto-enable attempt is in flight (hidden tab clicking + waiting
    // for the subscription to register).
    private var pendingPushToggle = false
    private var pushEnableTimeoutJob: Job? = null

    // Fire the OS notification-permission dialog EARLY — at onboarding completion,
    // before login. The permission needs no auth, so we get the one required tap
    // out of the way up front and let the actual x.com subscribe happen silently
    // later (maybeAutoEnablePush), once the user has logged in. Once-only.
    fun requestNotificationPermissionEarly() {
        if (prefs.getBoolean(KEY_NOTIF_PROMPTED, false)) return
        if (NotificationPermissionBroker.hasPermission(getApplication())) return
        NotificationPermissionBroker.ensurePermission(getApplication()) { granted ->
            prefs.edit().putBoolean(KEY_NOTIF_PROMPTED, true).apply()
            Log.i(tag, "notif permission (early) granted=$granted")
        }
    }

    // On reaching the authenticated home timeline: if notifications are permitted
    // and we haven't subscribed yet, silently enable x.com push in a hidden tab.
    // Permission was normally already granted at onboarding (above), so this just
    // proceeds with no dialog; if it wasn't (a user who onboarded before this
    // feature, or hasn't answered), we ask here as a fallback and proceed on grant.
    // True only if the user has EXPLICITLY turned the toggle off (persisted).
    // Absent key (never touched) is not "off" — new users still auto-enable.
    private fun userOptedOutOfNotifications(): Boolean =
        prefs.contains(WebNotificationHandler.KEY_NOTIFICATIONS_ON) &&
            !prefs.getBoolean(WebNotificationHandler.KEY_NOTIFICATIONS_ON, true)

    private fun maybeAutoEnablePush() {
        if (pushEnableEvaluated) return
        if (userOptedOutOfNotifications()) { pushEnableEvaluated = true; return }
        val alreadySubscribed = runCatching {
            PushSubscriptionStore(getApplication()).get("https://x.com/") != null
        }.getOrDefault(false)
        if (alreadySubscribed) { pushEnableEvaluated = true; return }

        if (NotificationPermissionBroker.hasPermission(getApplication())) {
            // Already permitted (typically from the early onboarding request) →
            // enable, no dialog.
            pushEnableEvaluated = true
            startBackgroundPushEnable()
        } else if (!prefs.getBoolean(KEY_NOTIF_PROMPTED, false)) {
            // Never asked → ask now (fallback), then enable on grant.
            pushEnableEvaluated = true
            NotificationPermissionBroker.ensurePermission(getApplication()) { granted ->
                prefs.edit().putBoolean(KEY_NOTIF_PROMPTED, true).apply()
                Log.i(tag, "auto-enable: POST_NOTIFICATIONS granted=$granted")
                if (granted) startBackgroundPushEnable()
            }
        } else {
            // Asked before and denied — respect it.
            pushEnableEvaluated = true
        }
    }

    // Which surface the in-flight enable is using.
    private enum class PushEnableMode { BACKGROUND, COVERED }
    private var pushEnableMode: PushEnableMode? = null

    // Preferred path: render settings on a SECOND, off-screen surface so the user
    // keeps browsing home with NO cover. Off-screen rendering is throttled so a
    // cold load is slow — but it's invisible, so we wait a long time. Only if it
    // still hasn't rendered do we fall back to the covered path.
    // The settings-sheet toggle. This is a purely app-level display switch:
    //  - OFF keeps the subscription AND the OS permission in place; it just tells
    //    WebNotificationHandler to suppress display (KEY_NOTIFICATIONS_ON).
    //  - ON restores display, and if we somehow aren't subscribed yet, kicks off
    //    the enable flow to subscribe.
    fun setNotificationsEnabled(on: Boolean) {
        prefs.edit().putBoolean(WebNotificationHandler.KEY_NOTIFICATIONS_ON, on).apply()
        _state.update { it.copy(notificationsEnabled = on) }
        if (!on) return
        val subscribed = runCatching {
            PushSubscriptionStore(getApplication()).get("https://x.com/") != null
        }.getOrDefault(false)
        if (!subscribed) enableNotificationsFromSettings()
    }

    // Run the subscribe flow on demand (turning the toggle on while unsubscribed).
    // No-op if one is already running.
    private fun enableNotificationsFromSettings() {
        if (_state.value.pushEnableInProgress) return
        if (NotificationPermissionBroker.hasPermission(getApplication())) {
            startBackgroundPushEnable()
        } else {
            NotificationPermissionBroker.ensurePermission(getApplication()) { granted ->
                prefs.edit().putBoolean(KEY_NOTIF_PROMPTED, true).apply()
                Log.i(tag, "manual enable: POST_NOTIFICATIONS granted=$granted")
                if (granted) startBackgroundPushEnable()
                else debugToast("Bouncer: notifications need permission")
            }
        }
    }

    // Re-attempt an interrupted enable when the app comes back to the foreground
    // (e.g. the screen slept mid-render). Cheap no-op if already on / in flight /
    // not eligible.
    private fun maybeRetryPushEnable() {
        if (userOptedOutOfNotifications()) return
        if (_state.value.notificationsEnabled) return
        if (_state.value.pushEnableInProgress) return
        if (!_state.value.hasLoggedIn || !isHome(_state.value.currentUrl)) return
        if (!NotificationPermissionBroker.hasPermission(getApplication())) return
        val alreadySubscribed = runCatching {
            PushSubscriptionStore(getApplication()).get("https://x.com/") != null
        }.getOrDefault(false)
        if (alreadySubscribed) {
            _state.update { it.copy(notificationsEnabled = true) }
            return
        }
        Log.i(tag, "auto-enable: retrying after foreground (prior attempt didn't complete)")
        startBackgroundPushEnable()
    }

    private fun startBackgroundPushEnable() {
        if (_state.value.pushEnableInProgress) return
        _state.update { it.copy(pushEnableInProgress = true) }
        pushEnableMode = PushEnableMode.BACKGROUND
        awaitingPushPreload = true
        BouncerGeckoView.beginBackgroundPushEnable()
        pushPreloadFallbackJob = viewModelScope.launch {
            delay(PUSH_BG_WAIT_MS)
            if (awaitingPushPreload && pushEnableMode == PushEnableMode.BACKGROUND) {
                awaitingPushPreload = false
                Log.w(tag, "auto-enable: off-screen render timed out ($PUSH_BG_WAIT_MS ms); falling back to covered")
                BouncerGeckoView.endBackgroundPushEnable()
                startCoveredPushEnable()
            }
        }
    }

    // Fallback path: display settings on the real webview UNDER an opaque cover
    // (reliable on-screen render), wait for its toggle, then click it.
    private fun startCoveredPushEnable() {
        pushEnableMode = PushEnableMode.COVERED
        awaitingPushPreload = true
        _state.update { it.copy(pushEnableCoverVisible = true, pushEnableInProgress = true) }
        BouncerGeckoView.showPushSettingsCovered()
        pushPreloadFallbackJob = viewModelScope.launch {
            delay(PUSH_PRELOAD_MAX_WAIT_MS)
            if (awaitingPushPreload) {
                awaitingPushPreload = false
                Log.w(tag, "auto-enable: settings tab never became ready; abandoning")
                teardownPushEnable()
                debugToast("Bouncer: notification setup failed (page never loaded)")
            }
        }
    }

    // Full teardown for the abandon / already-on paths (not the success path,
    // which swaps back early — see onPushSettingsReady).
    private fun teardownPushEnable() {
        when (pushEnableMode) {
            PushEnableMode.BACKGROUND -> BouncerGeckoView.endBackgroundPushEnable()
            PushEnableMode.COVERED -> BouncerGeckoView.endCoveredPushEnable(closeSettings = true)
            null -> {}
        }
        pushEnableMode = null
        _state.update { it.copy(pushEnableCoverVisible = false, pushEnableInProgress = false) }
    }

    // The hidden settings tab reported its toggle is rendered (and its current
    // on/off state) — click it if it's off, then wait for the subscription.
    fun onPushSettingsReady(alreadyOn: Boolean) {
        if (!awaitingPushPreload) return
        awaitingPushPreload = false
        pushPreloadFallbackJob?.cancel()
        pushPreloadFallbackJob = null

        if (alreadyOn) {
            // x.com push is already on — nothing to click; just drop the tab.
            Log.i(tag, "auto-enable: x.com toggle already on; tearing down")
            teardownPushEnable()
            debugToast("Bouncer: notifications already on ✓")
            return
        }

        pendingPushToggle = true
        PushRegistrar.onSubscriptionRegistered = { scope ->
            if (pendingPushToggle && isOnX(scope)) {
                pendingPushToggle = false
                PushRegistrar.onSubscriptionRegistered = null
                pushEnableTimeoutJob?.cancel()
                pushEnableTimeoutJob = null
                // CRITICAL: the browser subscribe() has resolved, but x.com now
                // POSTs that subscription to its OWN backend — that POST is what
                // actually flips the server-side toggle and enables delivery.
                // Closing the hidden tab immediately aborts that in-flight POST
                // (the toggle then reads "off" everywhere). Keep the tab alive for
                // a grace period so the backend registration completes first.
                Log.i(tag, "auto-enable: subscription registered for $scope; POST in background")
                debugToast("Bouncer: notifications enabled ✓")
                val mode = pushEnableMode
                pushEnableMode = null
                // Render/click are done — the screen can sleep now (the POST is
                // backgrounded network). Mark enabled (persist the display pref so
                // it survives restarts) so the toggle + retry-on-foreground reflect it.
                prefs.edit().putBoolean(WebNotificationHandler.KEY_NOTIFICATIONS_ON, true).apply()
                _state.update {
                    it.copy(pushEnableInProgress = false, notificationsEnabled = true)
                }
                // BACKGROUND: the off-screen view is already invisible and the
                // user never left home — just let the in-flight backend POST
                // finish, then remove it. COVERED: return home + drop the cover NOW
                // so the user can browse, keeping the settings session alive
                // (backgrounded) for the POST, then close it. Either way the POST
                // is a network call that finishes without a surface.
                if (mode == PushEnableMode.COVERED) {
                    BouncerGeckoView.endCoveredPushEnable(closeSettings = false)
                    _state.update { it.copy(pushEnableCoverVisible = false) }
                }
                viewModelScope.launch {
                    delay(PUSH_REGISTER_GRACE_MS)
                    if (mode == PushEnableMode.BACKGROUND) {
                        BouncerGeckoView.endBackgroundPushEnable()
                    } else {
                        BouncerGeckoView.closeCoveredSettings()
                    }
                    Log.i(tag, "auto-enable: settings tab closed after backend-registration grace")
                }
            }
        }
        // Safety net: if the click never yields a subscription (e.g. OS permission
        // denied), stop waiting and reclaim the hidden tab.
        pushEnableTimeoutJob = viewModelScope.launch {
            delay(PUSH_ENABLE_TIMEOUT_MS)
            if (pendingPushToggle) {
                pendingPushToggle = false
                PushRegistrar.onSubscriptionRegistered = null
                Log.w(tag, "auto-enable: no subscription within timeout; tearing down")
                teardownPushEnable()
                debugToast("Bouncer: notification setup failed (no subscription)")
            }
        }
        // Click x.com's real toggle in the hidden tab (see __ff_autoEnablePush).
        callJs("__ff_autoEnablePush")
    }

    // Debug-only, transient confirmation while testing the silent auto-enable.
    // No-op in release builds.
    private fun debugToast(msg: String) {
        if (!com.imbue.bouncer.BuildConfig.DEBUG) return
        viewModelScope.launch {
            Toast.makeText(getApplication(), msg, Toast.LENGTH_LONG).show()
        }
    }

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
            // (/home) is the signal to evaluate the one-time auto-enable for them.
            maybeAutoEnablePush()
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

    private fun applyPhrasesJson(platformId: String?, json: String) {
        val obj = runCatching { JSONObject(json) }.getOrElse {
            Log.w(tag, "Bad phrases JSON: $json")
            return
        }
        val pid = platformId ?: activePlatformId
        val phrases = obj.optJSONArray("phrases")?.let { arr ->
            buildList { for (i in 0 until arr.length()) add(arr.optString(i)) }
        }
        val count = if (obj.has("filteredCount")) obj.optInt("filteredCount", 0) else null
        // Stash into the pushing platform's slot so a background tab's updates
        // don't overwrite the visible feed's phrases/count.
        if (phrases != null) phrasesByPlatform[pid] = phrases
        if (count != null) countByPlatform[pid] = count
        // Only the active tab drives the visible UI.
        if (pid != activePlatformId) return

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
        // Pop the OS notification-permission dialog right now, before login, so the
        // one required tap is out of the way up front; the x.com subscribe then
        // happens silently once the user reaches their home timeline.
        requestNotificationPermissionEarly()
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
        // How long to let the off-screen (background, throttled) surface try to
        // render the toggle before falling back to the covered path. Generous
        // because it's invisible — the user browses home the whole time.
        private const val PUSH_BG_WAIT_MS = 90_000L
        // How long to wait for the covered settings tab to render its toggle
        // before abandoning; kept above the JS poller's 30s window.
        private const val PUSH_PRELOAD_MAX_WAIT_MS = 33_000L
        // After clicking the toggle, how long to wait for the subscription to
        // register before giving up (e.g. the user denied the OS permission).
        private const val PUSH_ENABLE_TIMEOUT_MS = 15_000L
        // After the browser subscribe resolves, how long to keep the hidden tab
        // alive so x.com's backend-registration POST (which flips the server-side
        // toggle + enables delivery) can finish before we close the session.
        private const val PUSH_REGISTER_GRACE_MS = 6_000L
        private const val TOP_PIN_PX = 80
        private const val HIDE_THRESHOLD_PX = 24
        private const val SHOW_THRESHOLD_PX = 16
        private const val SHARE_LOAD_DEADLINE_MS = 8_000L
        // Matches the iOS sheet's 10s aiPendingFallbackTask.
        private const val AI_PENDING_FALLBACK_MS = 10_000L
    }
}
