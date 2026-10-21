package com.imbue.bouncer.state

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.util.Log
import android.widget.Toast
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.imbue.bouncer.analytics.Analytics
import com.imbue.bouncer.push.NotificationPermissionBroker
import com.imbue.bouncer.push.PushRegistrar
import com.imbue.bouncer.push.PushSite
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
    // True only once a feedfilterAiSettings reply has actually arrived. The
    // first onPageStop can fire before the x.com content script exists (the
    // freshly-opened session delivers a success stop for about:blank while
    // loadUri waits on the extension install) — a request sent then vanishes,
    // so the flag must not latch on send or the native toggles would stay on
    // their defaults forever (e.g. "filter replies" showing on after restart
    // even though storage says off).
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
            // Native prefs are the display truth for this toggle. The JS-side
            // copy lives in per-origin page localStorage behind the content
            // script, which doesn't exist on the login flow (exclude_matches)
            // or before a feed page loads — seeding from it left the toggle
            // stuck on its default after every restart.
            filterReplies = prefs.getBoolean(KEY_FILTER_REPLIES, true),
            debugModeEnabled = prefs.getBoolean(KEY_DEBUG_MODE, false),
            // Each site's settings toggle: the persisted display preference,
            // defaulting to whether that site already has a subscription (so
            // pre-existing subscribers show "on").
            notificationsEnabled = run {
                val store = runCatching { PushSubscriptionStore(app) }.getOrNull()
                PushSite.entries.associateWith { site ->
                    WebNotificationHandler.notificationsSetting(prefs, site)
                        ?: runCatching { store?.get(site.scope) != null }.getOrDefault(false)
                }
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
        // Re-sync settings from storage whenever the sheet becomes visible —
        // the counterpart of the iOS sheet's .onAppear { loadFilterReplies() }.
        // Storage is the truth and JS can change it behind the native UI's
        // back (e.g. bouncing a reply flips filterReplies back on).
        if (_state.value.isSheetPresented) {
            callJs("__ff_loadAiSettings")
            loadExcludedAccounts()
        }
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
                activePlatformId = platformId,
                phrases = phrasesByPlatform[platformId] ?: emptyList(),
                filteredCount = countByPlatform[platformId] ?: 0,
                // First visit: the slot has no URL yet, so use the feed URL the
                // switch is about to load — falling back to the PREVIOUS
                // platform's URL left stale state (and the old NavBar label)
                // until the new tab's first onLocationChange.
                currentUrl = urlByPlatform[platformId]
                    ?: Platforms.byId(platformId)?.feedUrl
                    ?: it.currentUrl,
            )
        }
        callJs("__ff_loadAiSettings")
        loadExcludedAccounts()
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
            maybeAutoEnablePush(PushSite.X)
        }
        // Other sites: their feed is the cue (the settings page itself reports
        // a logged-out account, so a login form at the feed URL costs one
        // short-lived hidden tab).
        // A login in progress: an attempt made earlier this session (e.g. on a
        // mid-login redirect that looks like the feed) gets another go once
        // the feed is reached again.
        PushSite.entries.firstOrNull { it.isAuthFlow(url) }?.let { site ->
            pushEnableEvaluated -= site
            pushEnableSettled -= site
        }
        PushSite.entries.firstOrNull { it != PushSite.X && it.isHome(url) }?.let { site ->
            prefs.edit().putBoolean(KEY_PUSH_SITE_USED + site.platformId, true).apply()
            maybeAutoEnablePush(site)
        }
    }

    // ----- Silent push auto-enable -----

    // Turn on a site's push notifications automatically, with zero UI —
    // x.com's and Facebook's alike (PushSite). Attempted once per session per
    // site, on reaching that site's authenticated feed (onUrlChanged). Skipped
    // if a subscription already exists.
    //
    // Mechanism: load the site's push-settings page in a HIDDEN tab (shares
    // cookies, so already logged in), wait for its toggle to render
    // (onPushSettingsReady), then have JS click that toggle in place
    // (__ff_autoEnablePush). The site's own handler does the subscribe AND the
    // backend registration — the combination that actually delivers pushes.
    // Our WebPushDelegate captures the endpoint; once PushRegistrar reports it,
    // we tear the hidden tab down. One site at a time: a second site's attempt
    // queues behind the one in flight. The user sees nothing and waits for
    // nothing; the only surface is the Android notification-permission dialog
    // (NotificationPermissionBroker), which we can't self-grant and which
    // gates delivery anyway.
    // Sites whose once-per-session evaluation has run.
    private val pushEnableEvaluated = mutableSetOf<PushSite>()

    // Sites whose attempt this session ended with nothing left to do (toggle
    // already on, or logged out): not worth a foreground retry.
    private val pushEnableSettled = mutableSetOf<PushSite>()

    // Off-screen renders that timed out this session, per site. Foreground
    // retries stop at MAX_PUSH_ENABLE_TIMEOUTS so a site whose settings page
    // never renders doesn't spin up a hidden tab on every resume.
    private val pushEnableTimeouts = mutableMapOf<PushSite, Int>()

    // The site whose hidden settings tab is in flight, and the ones waiting.
    private var pushEnableSite: PushSite? = null
    private val pushEnableQueue = ArrayDeque<PushSite>()

    private var awaitingPushPreload = false
    private var pushPreloadFallbackJob: Job? = null

    // Set while an auto-enable attempt is in flight (hidden tab clicking + waiting
    // for the subscription to register).
    private var pendingPushToggle = false
    private var pushEnableTimeoutJob: Job? = null

    // Fire the OS notification-permission dialog EARLY — at onboarding completion,
    // before login. The permission needs no auth, so we get the one required tap
    // out of the way up front and let the actual site subscribe happen silently
    // later (maybeAutoEnablePush), once the user has logged in. Once-only.
    fun requestNotificationPermissionEarly() {
        if (prefs.getBoolean(KEY_NOTIF_PROMPTED, false)) return
        if (NotificationPermissionBroker.hasPermission(getApplication())) return
        NotificationPermissionBroker.ensurePermission(getApplication()) { granted ->
            prefs.edit().putBoolean(KEY_NOTIF_PROMPTED, true).apply()
            Log.i(tag, "notif permission (early) granted=$granted")
            Analytics.logNotificationPermissionResult(getApplication(), "onboarding", granted)
        }
    }

    private fun isSubscribed(site: PushSite): Boolean = runCatching {
        PushSubscriptionStore(getApplication()).get(site.scope) != null
    }.getOrDefault(false)

    // Whether the user has been logged in to the site on this install, so the
    // settings toggle only ever loads settings pages of sites they use. X has
    // its own login tracking; the others are marked on reaching their feed.
    private fun hasUsedSite(site: PushSite): Boolean =
        if (site == PushSite.X) _state.value.hasLoggedIn
        else prefs.getBoolean(KEY_PUSH_SITE_USED + site.platformId, false)

    // On reaching a site's authenticated feed: if notifications are permitted
    // and we haven't subscribed yet, silently enable its push in a hidden tab.
    // Permission was normally already granted at onboarding (above), so this just
    // proceeds with no dialog; if it wasn't (a user who onboarded before this
    // feature, or hasn't answered), we ask here as a fallback and proceed on grant.
    // True only if the user has EXPLICITLY turned the site's toggle off
    // (persisted). Never touched is not "off" — new users still auto-enable.
    private fun userOptedOutOfNotifications(site: PushSite): Boolean =
        WebNotificationHandler.notificationsSetting(prefs, site) == false

    private fun maybeAutoEnablePush(site: PushSite) {
        if (site in pushEnableEvaluated) return
        pushEnableEvaluated += site
        if (userOptedOutOfNotifications(site)) return
        if (isSubscribed(site)) return

        if (NotificationPermissionBroker.hasPermission(getApplication())) {
            // Already permitted (typically from the early onboarding request) →
            // enable, no dialog.
            startBackgroundPushEnable(site)
        } else if (!prefs.getBoolean(KEY_NOTIF_PROMPTED, false)) {
            // Never asked → ask now (fallback), then enable on grant.
            NotificationPermissionBroker.ensurePermission(getApplication()) { granted ->
                prefs.edit().putBoolean(KEY_NOTIF_PROMPTED, true).apply()
                Log.i(tag, "auto-enable: POST_NOTIFICATIONS granted=$granted")
                Analytics.logNotificationPermissionResult(getApplication(), "timeline_fallback", granted)
                if (granted) startBackgroundPushEnable(site)
            }
        }
        // Else: asked before and denied — respect it.
    }

    // A site's settings-sheet toggle. This is a purely app-level display
    // switch, one per site:
    //  - OFF keeps the site's subscription AND the OS permission in place; it
    //    just tells the display paths to suppress that site's notifications
    //    (WebNotificationHandler.notificationsKey).
    //  - ON restores display, and if the user uses the site but it somehow
    //    isn't subscribed yet, kicks off the enable flow to subscribe.
    fun setNotificationsEnabled(site: PushSite, on: Boolean) {
        prefs.edit().putBoolean(WebNotificationHandler.notificationsKey(site), on).apply()
        _state.update { it.copy(notificationsEnabled = it.notificationsEnabled + (site to on)) }
        Analytics.logNotificationsToggled(getApplication(), site, on)
        if (on && hasUsedSite(site) && !isSubscribed(site)) enableNotificationsFromSettings(listOf(site))
    }

    // Run the subscribe flow on demand (turning the toggle on while unsubscribed).
    // Sites already in flight or queued are not added twice.
    private fun enableNotificationsFromSettings(sites: List<PushSite>) {
        if (NotificationPermissionBroker.hasPermission(getApplication())) {
            sites.forEach { startBackgroundPushEnable(it) }
        } else {
            NotificationPermissionBroker.ensurePermission(getApplication()) { granted ->
                prefs.edit().putBoolean(KEY_NOTIF_PROMPTED, true).apply()
                Log.i(tag, "manual enable: POST_NOTIFICATIONS granted=$granted")
                Analytics.logNotificationPermissionResult(getApplication(), "settings", granted)
                if (granted) sites.forEach { startBackgroundPushEnable(it) }
                else debugToast("Bouncer: notifications need permission")
            }
        }
    }

    // Re-attempt an interrupted enable for the visible site when the app comes
    // back to the foreground (e.g. the screen slept mid-render). Cheap no-op if
    // already subscribed / in flight / not eligible.
    private fun maybeRetryPushEnable() {
        if (_state.value.pushEnableInProgress) return
        val url = _state.value.currentUrl
        val site = PushSite.entries.firstOrNull { it.isHome(url) } ?: return
        if (userOptedOutOfNotifications(site)) return
        if (!hasUsedSite(site) || site in pushEnableSettled) return
        if ((pushEnableTimeouts[site] ?: 0) >= MAX_PUSH_ENABLE_TIMEOUTS) return
        if (!NotificationPermissionBroker.hasPermission(getApplication())) return
        if (isSubscribed(site)) return
        Log.i(tag, "auto-enable: retrying ${site.name} after foreground (prior attempt didn't complete)")
        startBackgroundPushEnable(site)
    }

    private fun startBackgroundPushEnable(site: PushSite) {
        if (_state.value.pushEnableInProgress) {
            if (site != pushEnableSite && site !in pushEnableQueue) pushEnableQueue.addLast(site)
            return
        }
        pushEnableSite = site
        _state.update { it.copy(pushEnableInProgress = true) }
        awaitingPushPreload = true
        BouncerGeckoView.beginBackgroundPushEnable(site)
        pushPreloadFallbackJob = viewModelScope.launch {
            delay(PUSH_BG_WAIT_MS)
            if (awaitingPushPreload) {
                awaitingPushPreload = false
                pushEnableTimeouts[site] = (pushEnableTimeouts[site] ?: 0) + 1
                // Give up quietly; the next return to the foreground retries
                // (maybeRetryPushEnable).
                Log.w(tag, "auto-enable: off-screen render timed out ($PUSH_BG_WAIT_MS ms); abandoning")
                teardownPushEnable()
                debugToast("Bouncer: notification setup failed (page never loaded)")
            }
        }
    }

    // Full teardown for the abandon / already-on paths (not the success path,
    // which removes the off-screen view after a grace — see onPushSettingsReady).
    private fun teardownPushEnable() {
        BouncerGeckoView.endBackgroundPushEnable()
        _state.update { it.copy(pushEnableInProgress = false) }
        startNextQueuedPushEnable()
    }

    // The attempt in flight is over (either way): run the next queued site.
    private fun startNextQueuedPushEnable() {
        pushEnableSite = null
        val next = pushEnableQueue.removeFirstOrNull() ?: return
        // Turned off (or subscribed some other way) while it waited.
        if (isSubscribed(next) || userOptedOutOfNotifications(next)) return startNextQueuedPushEnable()
        startBackgroundPushEnable(next)
    }

    // The hidden settings tab reported its toggle is rendered (and its current
    // on/off state) — click it if it's off, then wait for the subscription.
    // loggedOut: the settings page bounced to the site's login (nothing to do).
    fun onPushSettingsReady(platformId: String?, alreadyOn: Boolean, loggedOut: Boolean = false) {
        val site = pushEnableSite ?: return
        if (platformId != null && platformId != site.platformId) return
        if (!awaitingPushPreload) return
        awaitingPushPreload = false
        pushPreloadFallbackJob?.cancel()
        pushPreloadFallbackJob = null

        if (loggedOut || alreadyOn) pushEnableSettled += site
        if (loggedOut) {
            Log.i(tag, "auto-enable: ${site.name} settings page asks for login; tearing down")
            teardownPushEnable()
            return
        }
        if (alreadyOn) {
            // Push is already on for this account — nothing to click; just drop the tab.
            Log.i(tag, "auto-enable: ${site.name} toggle already on; tearing down")
            teardownPushEnable()
            debugToast("Bouncer: ${site.fallbackTitle} notifications already on ✓")
            return
        }

        pendingPushToggle = true
        PushRegistrar.onSubscriptionRegistered = { scope ->
            if (pendingPushToggle && PushSite.forScope(scope) == site) {
                pendingPushToggle = false
                PushRegistrar.onSubscriptionRegistered = null
                pushEnableTimeoutJob?.cancel()
                pushEnableTimeoutJob = null
                // CRITICAL: the browser subscribe() has resolved, but the site now
                // POSTs that subscription to its OWN backend — that POST is what
                // actually flips the server-side toggle and enables delivery.
                // Closing the hidden tab immediately aborts that in-flight POST
                // (the toggle then reads "off" everywhere). Keep the tab alive for
                // a grace period so the backend registration completes first.
                Log.i(tag, "auto-enable: subscription registered for $scope; POST in background")
                Analytics.logPushSubscribed(getApplication())
                debugToast("Bouncer: ${site.fallbackTitle} notifications enabled ✓")
                // Render/click are done — the screen can sleep now (the POST is
                // backgrounded network). Mark enabled (persist the display pref so
                // it survives restarts) so the toggle + retry-on-foreground reflect it.
                prefs.edit().putBoolean(WebNotificationHandler.notificationsKey(site), true).apply()
                _state.update {
                    it.copy(
                        pushEnableInProgress = false,
                        notificationsEnabled = it.notificationsEnabled + (site to true),
                    )
                }
                // The off-screen view is invisible and the user never left their
                // feed — just let the in-flight backend POST finish, then remove
                // it. The next queued site waits for that: the off-screen view is
                // a single slot.
                viewModelScope.launch {
                    delay(PUSH_REGISTER_GRACE_MS)
                    BouncerGeckoView.endBackgroundPushEnable()
                    Log.i(tag, "auto-enable: settings tab closed after backend-registration grace")
                    startNextQueuedPushEnable()
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
        // Click the site's real toggle in the hidden tab (see __ff_autoEnablePush).
        bridge?.callJsOn(site.platformId, "__ff_autoEnablePush")
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

    // ----- Load-failure handling (offline launch etc.) -----
    //
    // GeckoView shows NO error page when a top-level load fails (the default
    // NavigationDelegate.onLoadError returns null), so a launch without
    // network leaves a permanently blank white view — which a user (or a Play
    // reviewer) reads as a frozen app. Track the failure, surface a native
    // error view, and auto-retry as soon as a usable network appears.
    private var failedUrl: String? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    fun onLoadError(uri: String?) {
        failedUrl = uri
        _state.update { it.copy(loadFailed = true) }
        watchForConnectivity()
    }

    fun retryLoad() {
        _state.update { it.copy(loadFailed = false) }
        session?.loadUri(failedUrl ?: currentUrlOrInitial())
    }

    // Retry when connectivity comes back. onAvailable fires as soon as a
    // network connects (also immediately on registration if one exists);
    // VALIDATED in onCapabilitiesChanged is the stronger "internet actually
    // works" signal that arrives once the connectivity check passes. Retrying
    // on both is safe: retryLoad clears loadFailed, so the second event
    // no-ops unless the first retry already failed again — in which case the
    // extra attempt is exactly what we want.
    private fun watchForConnectivity() {
        if (networkCallback != null) return
        val cm = getApplication<Application>()
            .getSystemService(ConnectivityManager::class.java) ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                retryFailedLoadOnMain()
            }
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
                    retryFailedLoadOnMain()
                }
            }
        }
        runCatching { cm.registerDefaultNetworkCallback(cb) }
            .onSuccess { networkCallback = cb }
            .onFailure { Log.w(tag, "registerDefaultNetworkCallback failed", it) }
    }

    // NetworkCallback methods run on a ConnectivityManager binder thread;
    // session/loadUri and state updates belong on Main.
    private fun retryFailedLoadOnMain() {
        viewModelScope.launch {
            if (_state.value.loadFailed) {
                Log.i(tag, "network available; retrying failed load")
                retryLoad()
            }
        }
    }

    private fun stopWatchingConnectivity() {
        val cb = networkCallback ?: return
        networkCallback = null
        val cm = getApplication<Application>()
            .getSystemService(ConnectivityManager::class.java) ?: return
        runCatching { cm.unregisterNetworkCallback(cb) }
    }

    override fun onCleared() {
        stopWatchingConnectivity()
        super.onCleared()
    }

    fun setCanGoBack(canGoBack: Boolean) {
        _state.update { it.copy(canGoBack = canGoBack) }
    }

    fun setCanGoForward(canGoForward: Boolean) {
        _state.update { it.copy(canGoForward = canGoForward) }
    }

    fun onPageStop(success: Boolean) {
        if (!success) return
        // A load succeeded: the failure that put up the error view is over.
        // Stop the connectivity watcher too — it re-registers on the next error.
        failedUrl = null
        stopWatchingConnectivity()
        if (_state.value.loadFailed) {
            _state.update { it.copy(loadFailed = false) }
        }
        // Stamp the persisted choice into this page's storage BEFORE the read
        // below, so the reply reflects it.
        syncFilterRepliesToPage()
        syncDebugModeToPage()
        maybeLoadAiSettings()
        if (prefs.getBoolean(KEY_PENDING_AI_SLOP_SEED, false) && isOnX(_state.value.currentUrl)) {
            prefs.edit().remove(KEY_PENDING_AI_SLOP_SEED).apply()
            // The onboarding "Remove AI Slop" checkbox. Planting the seed
            // phrase engages AI detection deterministically
            // (isAiDetectionPhrase in shared/utils.ts) — the same end state
            // as tapping the sparkle indicator, no judge round trip needed.
            // The badge dismissal is persisted BEFORE the phrase add,
            // mirroring toggleAiDetection's ordering on iOS: the pushes the
            // add triggers re-read the flag from storage.
            callJs("__ff_setStorage", JSONObject().put("aiIndicatorBadgeDismissed", true))
            callJs("__ff_addPhrase", "AI slop")
        }
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
            maybeAutoEnablePush(PushSite.X)
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
                aiBadgeDismissed = if (obj.has("aiBadgeDismissed")) obj.optBoolean("aiBadgeDismissed") else s.aiBadgeDismissed,
            )
        }
    }

    // ----- UI → JS -----

    fun setSheetPresented(open: Boolean) {
        _state.update { it.copy(isSheetPresented = open) }
        callJs("__ff_setSheetClass", open)
        // Same on-appear re-sync as onShowSheet: storage is the truth.
        if (open) {
            callJs("__ff_loadAiSettings")
            loadExcludedAccounts()
        }
    }

    // Excluded accounts for the active platform. Storage is the truth (the
    // filtered-posts modal's "Never filter @x" button writes it directly);
    // the mutate bridge re-posts the updated list once the write resolves,
    // and the reply lands in onAiSettingsReply.
    private fun loadExcludedAccounts() {
        callJs("__ff_loadExcludedAccounts", _state.value.activePlatformId)
    }

    fun addExcludedAccount(text: String) {
        val t = text.trim()
        if (t.isEmpty()) return
        callJs("__ff_mutateExcludedAccount", "add", _state.value.activePlatformId, t)
    }

    fun removeExcludedAccount(account: String) {
        // Optimistic removal so the row disappears on tap; the bridge's
        // re-post confirms (or restores) the real list.
        _state.update { it.copy(excludedAccounts = it.excludedAccounts - account) }
        callJs("__ff_mutateExcludedAccount", "remove", _state.value.activePlatformId, account)
    }

    // Open an excluded account's profile in the webview (the app is the
    // browser, so in-app navigation is the native equivalent of a link).
    // Twitter/YouTube have handle-derived profile URLs; LinkedIn stores
    // display names with no stable URL, so the sheet renders those rows
    // non-clickable and this is never called for them.
    fun openExcludedAccount(account: String) {
        val handle = account.removePrefix("@")
        val url = when (_state.value.activePlatformId) {
            "twitter" -> "https://x.com/$handle"
            "youtube" -> "https://www.youtube.com/@$handle"
            else -> return
        }
        setSheetPresented(false)
        navigateTo(url)
    }

    fun completeOnboarding(enableAiSlop: Boolean) {
        prefs.edit().putBoolean(KEY_ONBOARDED, true).apply()
        // The extension isn't reachable yet — the GeckoView (and its content
        // script) only mounts after onboarding — so park the intent in prefs
        // and plant the seed phrase on the first x.com load (onPageStop).
        if (enableAiSlop) {
            prefs.edit().putBoolean(KEY_PENDING_AI_SLOP_SEED, true).apply()
        }
        // Checking the box IS the action the sparkle's first-run "REMOVE AI
        // SLOP?" pill advertises — treat it as already tapped so the sheet
        // opens with the plain sparkle (the storage flag is persisted
        // alongside the seed phrase in onPageStop).
        _state.update {
            it.copy(
                hasCompletedOnboarding = true,
                aiBadgeDismissed = it.aiBadgeDismissed || enableAiSlop,
            )
        }
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

    // Persist natively (display truth, survives restarts and pages where no
    // content script is reachable), then mirror into the JS pipeline's storage
    // key (`filterReplies`); the content script's storage.onChanged listener
    // applies it live, including un-hiding already-filtered replies when
    // turned off. If the mirror write is dropped (login screen, mid-load),
    // syncFilterRepliesToPage re-applies it on the next page load.
    fun setFilterReplies(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_FILTER_REPLIES, enabled).apply()
        _state.update { it.copy(filterReplies = enabled) }
        callJs("__ff_setStorage", JSONObject().put("filterReplies", enabled))
    }

    // Same shape as setFilterReplies: native prefs are the display truth, the
    // `debugMode` storage key is what the content script reads to enable the
    // press-and-hold reasoning popup (addContextMenuHandler in content/ui.ts).
    fun setDebugMode(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_DEBUG_MODE, enabled).apply()
        _state.update { it.copy(debugModeEnabled = enabled) }
        callJs("__ff_setStorage", JSONObject().put("debugMode", enabled))
    }

    private fun syncDebugModeToPage() {
        if (!prefs.contains(KEY_DEBUG_MODE)) return
        val enabled = prefs.getBoolean(KEY_DEBUG_MODE, false)
        callJs("__ff_setStorage", JSONObject().put("debugMode", enabled))
    }

    // Re-apply the natively persisted choice to the freshly loaded page. The
    // JS pipeline reads page storage, which on Android is per-origin
    // localStorage (the polyfill has no native store) — so every origin the
    // user filters needs the value stamped in, and a toggle flipped while no
    // content script was reachable would otherwise never take effect.
    private fun syncFilterRepliesToPage() {
        if (!prefs.contains(KEY_FILTER_REPLIES)) return
        val enabled = prefs.getBoolean(KEY_FILTER_REPLIES, true)
        callJs("__ff_setStorage", JSONObject().put("filterReplies", enabled))
    }

    fun goBack() {
        session?.goBack()
    }

    fun goForward() {
        session?.goForward()
    }

    fun reload() {
        // After a failed load there may be no committed page to reload —
        // session.reload() is a silent no-op then. Re-drive the failed URL.
        if (_state.value.loadFailed) {
            retryLoad()
            return
        }
        session?.reload()
    }

    fun navigateTo(url: String) {
        val normalized = if (url.contains("://")) url else "https://$url"
        session?.loadUri(normalized)
    }

    fun onAiSettingsReply(json: String) {
        val obj = runCatching { JSONObject(json) }.getOrElse { return }
        aiSettingsLoaded = true
        // JS can flip this setting itself (bouncing a reply on a permalink
        // turns it back on — ensureFilterRepliesEnabled in content/ui.ts), so
        // follow reported page state into prefs; otherwise the next page load
        // would stamp the stale native value back over the user's action.
        if (obj.has("filterReplies")) {
            prefs.edit()
                .putBoolean(KEY_FILTER_REPLIES, obj.optBoolean("filterReplies", true))
                .apply()
        }
        _state.update { s ->
            s.copy(
                aiDetectionOn = if (obj.has("aiDetectionOn")) obj.optBoolean("aiDetectionOn") else s.aiDetectionOn,
                filterReplies = if (obj.has("filterReplies")) obj.optBoolean("filterReplies", s.filterReplies) else s.filterReplies,
                aiBadgeDismissed = if (obj.has("aiBadgeDismissed")) obj.optBoolean("aiBadgeDismissed") else s.aiBadgeDismissed,
                excludedAccounts = obj.optJSONArray("excludedAccounts")?.let { arr ->
                    List(arr.length()) { i -> arr.optString(i) }.filter { it.isNotEmpty() }
                } ?: s.excludedAccounts,
            )
        }
    }

    // Re-request on every full page load until a reply lands (onAiSettingsReply
    // sets the flag). Requests sent to a page without the content script are
    // silently lost, so latching on send would freeze the UI on its defaults.
    private fun maybeLoadAiSettings() {
        if (aiSettingsLoaded) return
        callJs("__ff_loadAiSettings")
    }

    private fun callJs(fn: String, vararg args: Any?) {
        bridge?.callJs(fn, *args)
    }

    companion object {
        private const val KEY_ONBOARDED = "hasCompletedOnboarding"
        private const val KEY_PENDING_AI_SLOP_SEED = "pendingAiSlopSeed"
        private const val KEY_LOGGED_IN = "hasLoggedIn"
        private const val KEY_BOUNCER_TOOLTIP_SEEN = "hasSeenBouncerTooltip"
        private const val KEY_FILTER_REPLIES = "filterReplies"
        private const val KEY_DEBUG_MODE = "debugMode"
        private const val KEY_NOTIF_PROMPTED = "hasPromptedNotifications"
        // + platformId: the user has reached that site's feed on this install.
        private const val KEY_PUSH_SITE_USED = "pushSiteUsed:"
        // How long to let the off-screen (background, throttled) surface try to
        // render the toggle before abandoning the attempt. Generous because it's
        // invisible — the user browses home the whole time.
        private const val PUSH_BG_WAIT_MS = 90_000L
        // Timed-out attempts per site per session before foreground retries stop.
        private const val MAX_PUSH_ENABLE_TIMEOUTS = 3
        // After clicking the toggle, how long to wait for the subscription to
        // register before giving up (e.g. the user denied the OS permission).
        private const val PUSH_ENABLE_TIMEOUT_MS = 15_000L
        // After the browser subscribe resolves, how long to keep the hidden tab
        // alive so the site's backend-registration POST (which flips the server-side
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
