package com.imbue.bouncer.web

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.util.Log
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.browser.customtabs.CustomTabsIntent
import com.imbue.bouncer.push.BouncerPushDelegate
import com.imbue.bouncer.push.NotificationPermissionBroker
import com.imbue.bouncer.push.WebNotificationHandler
import com.imbue.bouncer.state.BouncerViewModel
import com.imbue.bouncer.state.Platform
import com.imbue.bouncer.state.Platforms
import kotlinx.coroutines.CoroutineScope
import org.mozilla.geckoview.AllowOrDeny
import org.mozilla.geckoview.ContentBlocking
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.GeckoRuntimeSettings
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoView
import org.mozilla.geckoview.WebExtension

object BouncerGeckoView {
    private const val TAG = "FF/Gecko"
    private const val EXT_LOCATION = "resource://android/assets/web_ext_gecko/"
    private const val EXT_ID = "bouncer@imbue.com"
    private const val PORT_NAME = "bouncer"
    private const val PUSH_SETTINGS_URL = "https://x.com/settings/push_notifications"

    private val ALLOWED_HOSTS = setOf(
        "x.com", "twitter.com", "t.co",
        "twimg.com", "pbs.twimg.com", "abs.twimg.com", "video.twimg.com",
        "linkedin.com", "licdn.com", "static.licdn.com", "media.licdn.com",
        "accounts.google.com", "accounts.youtube.com", "google.com", "gstatic.com",
    )

    @Volatile private var runtime: GeckoRuntime? = null
    @Volatile private var installResult: GeckoResult<WebExtension>? = null
    @Volatile private var bridge: GeckoBridge? = null
    @Volatile private var ready: Boolean = false

    // For the service-worker openWindow path (notification clicks): the SW
    // needs the currently-displayed session to load the target URL into.
    @Volatile private var vmRef: BouncerViewModel? = null

    // One live GeckoSession per platform ("tabs"), created lazily on first visit
    // and kept warm so switching back is instant — the GeckoView equivalent of
    // iOS's per-platform WebViewCache. The single GeckoView shows one at a time
    // via setSession(). viewRef/appCtxRef let switchToPlatform run without the
    // caller threading them in.
    private val sessions = mutableMapOf<String, GeckoSession>()
    @Volatile private var activePlatformId: String = "twitter"
    @Volatile private var viewRef: GeckoView? = null
    @Volatile private var appCtxRef: Context? = null

    private fun isActiveSession(session: GeckoSession): Boolean =
        session === sessions[activePlatformId]

    /** The warm runtime, if any — used by the FCM service to deliver push events. */
    fun runtimeOrNull(): GeckoRuntime? = runtime

    // Content-process kill in the background → onKill fires off the UI thread
    // or while the activity is paused; running the reopen+setSession synchronously
    // there can leave the new content process with no compositor target, so the
    // view stays stuck on the GeckoView default background (gray) forever.
    // Defer until the next ON_RESUME, when the SurfaceView is guaranteed live.
    @Volatile private var activityForegrounded: Boolean = false
    @Volatile private var pendingRecovery: Boolean = false

    // 0 = no cover. Set from BouncerApp via setCoverColor / passed into create
    // so the recovery reload doesn't flash the GeckoView's default gray.
    @Volatile private var coverColor: Int = 0

    // Dynamic-toolbar geometry, owned here so it survives session swaps.
    // setDynamicToolbarMaxHeight / setVerticalClipping are per-surface
    // compositor state: GeckoView.setSession() attaches a fresh session whose
    // compositor resets both to 0. Without re-applying, Gecko stops reserving
    // space for the nav bar and x.com's position:fixed bottom tab strip drops
    // behind Bouncer's BottomAppBar. BouncerApp pushes the current values via
    // the setters below; reapplyDynamicToolbar() replays them after each swap.
    @Volatile private var dynamicToolbarMaxHeightPx: Int = 0
    @Volatile private var verticalClippingPx: Int = 0

    fun isReady(): Boolean = ready

    fun setActivityForegrounded(foregrounded: Boolean) {
        activityForegrounded = foregrounded
    }

    fun setCoverColor(color: Int) {
        coverColor = color
    }

    // BouncerApp calls these from its dynamic-toolbar LaunchedEffect /
    // snapshotFlow instead of touching the GeckoView directly, so this object
    // owns the latest values and can re-apply them after every setSession().
    // Applied directly (no post) to preserve the original call timing; the
    // GeckoView is already surfaced by the time BouncerApp pushes values.
    fun setDynamicToolbarMaxHeight(px: Int) {
        dynamicToolbarMaxHeightPx = px
        viewRef?.setDynamicToolbarMaxHeight(px)
    }

    fun setVerticalClipping(clip: Int) {
        verticalClippingPx = clip
        viewRef?.setVerticalClipping(clip)
    }

    // Replay the dynamic-toolbar geometry onto the view's freshly-attached
    // session. Posted to the next frame: right after setSession() the swapped
    // session's surface may not be attached yet, and setDynamicToolbarMaxHeight
    // throws without one.
    private fun reapplyDynamicToolbar(view: GeckoView) {
        view.post {
            view.setDynamicToolbarMaxHeight(dynamicToolbarMaxHeightPx)
            view.setVerticalClipping(verticalClippingPx)
        }
    }

    // The activity declares configChanges="uiMode" so the process survives a
    // system theme toggle; without this hook the runtime keeps the uiMode it
    // captured at warm-up and prefers-color-scheme stays frozen.
    fun onConfigurationChanged(ctx: Context) {
        runtime?.settings?.preferredColorScheme = colorSchemeFor(ctx)
    }

    private fun colorSchemeFor(ctx: Context): Int {
        val night = ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        return if (night == Configuration.UI_MODE_NIGHT_YES) {
            GeckoRuntimeSettings.COLOR_SCHEME_DARK
        } else {
            GeckoRuntimeSettings.COLOR_SCHEME_LIGHT
        }
    }

    // Pay the GeckoRuntime + extension-install cost during process startup
    // (from BouncerApplication.onCreate) so it doesn't land on the activity's
    // first composition and trigger ANR. GeckoRuntime.create is @UiThread, so
    // the caller must invoke this on the main thread.
    fun warmUp(appCtx: Context, scope: CoroutineScope, appCheck: AppCheckBridge) {
        if (runtime != null) return
        synchronized(this) {
            if (runtime != null) return
            // Pre-grant the Web Notifications permission for every origin we load,
            // via a Gecko pref delivered through a config file. x.com's push-enable
            // path calls Notification.requestPermission(), which the browser
            // refuses without a genuine in-page tap (dom.webnotifications.
            // requireuserinteraction, on by default) — so a scripted toggle click
            // can never turn push on. Defaulting desktop-notification to ALLOW (1)
            // makes Notification.permission report "granted" with no prompt and no
            // gesture, so our silent auto-enable click succeeds. Safe here because
            // this runtime only ever loads x.com / linkedin, and delivery is still
            // gated by the Android POST_NOTIFICATIONS runtime permission.
            val configPath = writeGeckoConfig(appCtx)
            val settingsBuilder = GeckoRuntimeSettings.Builder()
                .consoleOutput(true)
                .debugLogging(true)
                .preferredColorScheme(colorSchemeFor(appCtx))
                // Stock GeckoView blocks ad/analytic/social tracker content in
                // all windows (Firefox-Strict level). x.com's login flow loads
                // cross-site resources from twitter.com, which is on that
                // blocklist; blocking them breaks the login integrity check and
                // X rejects username logins as suspicious. Match Firefox's
                // default (Standard) instead: no tracker-content blocking,
                // keep default cookie isolation and Safe Browsing.
                .contentBlocking(
                    ContentBlocking.Settings.Builder()
                        .antiTracking(ContentBlocking.AntiTracking.NONE)
                        .build()
                )
            // A non-null, non-empty configFilePath is read unconditionally (even
            // on a signed release build); without it, GeckoView only reads the
            // debug-app default path.
            if (configPath != null) settingsBuilder.configFilePath(configPath)
            val settings = settingsBuilder.build()
            val r = GeckoRuntime.create(appCtx, settings)
            wirePushDelegates(r, appCtx, scope)
            val b = GeckoBridge(appCtx, scope, appCheck)
            val result = r.webExtensionController.ensureBuiltIn(EXT_LOCATION, EXT_ID)
            result.accept(
                { ext ->
                    if (ext != null) {
                        ext.setMessageDelegate(b, PORT_NAME)
                        Log.i(TAG, "setMessageDelegate registered for port=$PORT_NAME on ${ext.id}")
                        Log.i(TAG, "extension ready: ${ext.id}")
                    } else {
                        Log.e(TAG, "ensureBuiltIn returned null")
                    }
                    ready = true
                },
                { err ->
                    Log.e(TAG, "ensureBuiltIn failed", err)
                    // Unblock the splash even on install failure so the user
                    // isn't stuck staring at the splash forever.
                    ready = true
                },
            )
            installResult = result
            bridge = b
            runtime = r
        }
    }

    // Materialize the geckoview-config.yaml consumed via configFilePath(). It
    // must be a real file the process can read (assets paths don't qualify), so
    // we write it into filesDir. Returns the absolute path, or null on failure
    // (in which case we just fall back to the normal prompt-gated permission).
    private fun writeGeckoConfig(appCtx: Context): String? = runCatching {
        val cfg = java.io.File(appCtx.filesDir, "geckoview-config.yaml")
        cfg.writeText("prefs:\n  permissions.default.desktop-notification: 1\n")
        cfg.absolutePath
    }.getOrNull()

    // Runtime-level Web Push wiring: the delegate answers pushManager
    // subscribe/get/unsubscribe from x.com, the notification handler surfaces
    // service-worker notifications as Android notifications, and the
    // service-worker delegate serves clients.openWindow on notification click.
    private fun wirePushDelegates(r: GeckoRuntime, appCtx: Context, scope: CoroutineScope) {
        r.webPushController.setDelegate(BouncerPushDelegate(appCtx))
        r.setWebNotificationDelegate(WebNotificationHandler(appCtx, scope))
        r.setServiceWorkerDelegate(
            object : GeckoRuntime.ServiceWorkerDelegate {
                override fun onOpenWindow(url: String): GeckoResult<GeckoSession> {
                    val session = vmRef?.mainSession()
                    return if (session != null && session.isOpen) {
                        session.loadUri(url)
                        GeckoResult.fromValue(session)
                    } else {
                        Log.w(TAG, "onOpenWindow with no open session: $url")
                        GeckoResult.fromValue(null)
                    }
                }
            },
        )
    }

    fun create(
        ctx: Context,
        scope: CoroutineScope,
        vm: BouncerViewModel,
        appCheck: AppCheckBridge,
        coverColor: Int,
    ): GeckoView {
        val appCtx = ctx.applicationContext
        // Defensive: should already be warm via Application.onCreate.
        warmUp(appCtx, scope, appCheck)
        val r = runtime!!
        vmRef = vm
        appCtxRef = appCtx
        bridge?.let { vm.attachBridge(it) }
        this.coverColor = coverColor

        val view = GeckoView(ctx)
        viewRef = view

        val initialUrl = vm.initialUrl()
        activePlatformId = Platforms.fromUrl(initialUrl)?.id ?: "twitter"

        // Reuse a warm session if one survived (e.g. process-level singleton
        // across an activity re-create); otherwise create the first tab.
        val warm = sessions[activePlatformId]?.takeIf { it.isOpen }
        val session = warm ?: GeckoSession().also { s ->
            wireDelegates(s, view, r, appCtx, vm)
            s.open(r)
            sessions[activePlatformId] = s
        }
        bridge?.setActivePlatform(activePlatformId)
        // setSession before coverUntilFirstPaint: the cover-listener binds against
        // the GeckoView's current compositor state, and we want it bound to the
        // session that will actually produce the next paint. If we cover first,
        // the listener can end up waiting on a paint event that no longer arrives.
        view.setSession(session)
        reapplyDynamicToolbar(view)
        if (coverColor != 0) view.coverUntilFirstPaint(coverColor)
        vm.attachSession(session)
        session.setActive(true)

        if (warm != null) return view // already loaded; nothing more to do

        val pending = installResult
        if (pending != null) {
            pending.accept(
                { _ -> session.loadUri(initialUrl) },
                { err ->
                    Log.w(TAG, "extension install failed; loading anyway", err)
                    session.loadUri(initialUrl)
                },
            )
        } else {
            session.loadUri(initialUrl)
        }
        return view
    }

    // Swap the visible tab to [platform], creating its session on first visit
    // and keeping it warm thereafter — so a later switch back is instant. The
    // heavy lifting (per-tab port routing, per-platform phrases/count) lives in
    // GeckoBridge and BouncerViewModel; this just manages the sessions.
    fun switchToPlatform(platform: Platform) {
        val view = viewRef ?: return
        val r = runtime ?: return
        val vm = vmRef ?: return
        val appCtx = appCtxRef ?: view.context.applicationContext
        if (activePlatformId == platform.id) {
            // Already showing this platform: treat as "go to feed" (e.g. back
            // to the home timeline from a profile).
            sessions[platform.id]?.loadUri(platform.feedUrl)
            return
        }
        val warm = sessions[platform.id]?.takeIf { it.isOpen }
        val target = warm ?: GeckoSession().also { s ->
            wireDelegates(s, view, r, appCtx, vm)
            s.open(r)
            sessions[platform.id] = s
            s.loadUri(platform.feedUrl)
        }
        sessions[activePlatformId]?.setActive(false)
        activePlatformId = platform.id
        bridge?.setActivePlatform(platform.id)
        view.setSession(target)
        reapplyDynamicToolbar(view)
        if (coverColor != 0) view.coverUntilFirstPaint(coverColor)
        vm.attachSession(target)
        vm.onPlatformSwitched(platform.id)
        target.setActive(true)
    }

    // ----- Push auto-enable: x.com's settings page as a real tab, under a cover -----
    //
    // A background GeckoSession that's never attached to the GeckoView has no
    // compositor surface, and Gecko won't fully render x.com's settings SPA cold
    // without one (rAF/layout are suspended) — so the toggle never mounts. The fix
    // is to display the settings session on the REAL view (so it's surfaced and
    // renders reliably, exactly like the LinkedIn tab) while the caller holds an
    // opaque cover over it, so the user never sees x.com's settings page. Once its
    // toggle renders, JS clicks it (bridge_page.js __ff_autoEnablePush); x.com then
    // subscribes AND registers with its backend, our WebPushDelegate captures the
    // endpoint, and we swap back to the warm home tab and drop the cover.
    // activePlatformId stays "twitter" so bridge routing follows the settings tab.
    @Volatile private var pushSettingsSession: GeckoSession? = null
    @Volatile private var pushHomeSession: GeckoSession? = null

    fun showPushSettingsCovered() {
        val view = viewRef ?: return
        val r = runtime ?: return
        val vm = vmRef ?: return
        val appCtx = appCtxRef ?: view.context.applicationContext
        val home = sessions[activePlatformId] ?: return
        if (pushSettingsSession != null) return
        pushHomeSession = home
        val s = GeckoSession()
        wireDelegates(s, view, r, appCtx, vm)
        s.open(r)
        pushSettingsSession = s
        // Make it the displayed session: point the platform slot at it (so
        // isActiveSession()/bridge routing follow it), attach it to the view for a
        // real surface, and load settings. The caller's opaque cover hides it.
        sessions[activePlatformId] = s
        view.post {
            home.setActive(false)
            view.setSession(s)
            reapplyDynamicToolbar(view)
            if (coverColor != 0) view.coverUntilFirstPaint(coverColor)
            vm.attachSession(s)
            s.setActive(true)
            s.loadUri(PUSH_SETTINGS_URL)
            Log.i(TAG, "showPushSettingsCovered: settings tab displayed under cover")
        }
    }

    // Swap back to the retained (warm) home tab. With closeSettings=true the
    // settings tab is closed immediately (done / abandoned). With false it's kept
    // OPEN but backgrounded so x.com's in-flight backend-registration POST can
    // finish — call closeCoveredSettings() after a grace to reclaim it.
    fun endCoveredPushEnable(closeSettings: Boolean = true) {
        val view = viewRef ?: return
        val vm = vmRef ?: return
        val home = pushHomeSession
        val settings = pushSettingsSession
        pushHomeSession = null
        if (closeSettings) pushSettingsSession = null
        if (home == null) return
        sessions[activePlatformId] = home
        view.post {
            view.setSession(home)
            reapplyDynamicToolbar(view)
            if (coverColor != 0) view.coverUntilFirstPaint(coverColor)
            vm.attachSession(home)
            home.setActive(true)
            if (settings != null && settings !== home) {
                settings.setActive(false)
                if (closeSettings && settings.isOpen) settings.close()
            }
            Log.i(TAG, "endCoveredPushEnable: back to home (closeSettings=$closeSettings)")
        }
    }

    // Close the settings tab kept alive by endCoveredPushEnable(closeSettings=false)
    // once its backend POST has had time to complete.
    fun closeCoveredSettings() {
        val s = pushSettingsSession ?: return
        pushSettingsSession = null
        if (s.isOpen) s.close()
        Log.i(TAG, "closeCoveredSettings: settings session closed")
    }

    // ----- Background push-enable: settings on a SECOND, off-screen surface -----
    //
    // Give the settings session its OWN surface: a second GeckoView added to the
    // window but shoved off the right edge, so it renders out of sight while the
    // main view keeps showing home (no cover, fully interactive). Off-screen
    // rendering is throttled by Gecko so a cold load is slow, but it's invisible,
    // so the VM waits generously. Clicks the toggle + subscribes, then is removed.
    @Volatile private var offscreenView: GeckoView? = null
    @Volatile private var offscreenSession: GeckoSession? = null

    fun beginBackgroundPushEnable() {
        val mainView = viewRef ?: return
        val r = runtime ?: return
        val vm = vmRef ?: return
        val appCtx = appCtxRef ?: mainView.context.applicationContext
        if (offscreenSession != null) return
        val activity = activityOf(mainView.context) ?: run {
            Log.w(TAG, "beginBackgroundPushEnable: no activity; cannot attach off-screen view")
            return
        }
        mainView.post {
            val root = activity.window.decorView as? ViewGroup ?: return@post
            val gv = GeckoView(activity)
            val s = GeckoSession()
            wireDelegates(s, gv, r, appCtx, vm)
            s.open(r)
            gv.setSession(s)
            // Full-size so x.com lays out normally, but translated far off the
            // right edge so it's never visible. VISIBLE is required for the
            // SurfaceView to be handed a real surface to render into.
            gv.layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            )
            gv.translationX = 100000f
            gv.isClickable = false
            gv.isFocusable = false
            root.addView(gv)
            offscreenView = gv
            offscreenSession = s
            s.setActive(true)
            s.loadUri(PUSH_SETTINGS_URL)
            Log.i(TAG, "beginBackgroundPushEnable: off-screen settings view attached")
        }
    }

    fun endBackgroundPushEnable() {
        val gv = offscreenView
        val s = offscreenSession
        offscreenView = null
        offscreenSession = null
        (viewRef ?: gv)?.post {
            try {
                s?.setActive(false)
                gv?.releaseSession()
                (gv?.parent as? ViewGroup)?.removeView(gv)
                if (s != null && s.isOpen) s.close()
            } catch (e: Throwable) {
                Log.w(TAG, "endBackgroundPushEnable cleanup failed", e)
            }
            Log.i(TAG, "endBackgroundPushEnable: off-screen view removed")
        }
    }

    private fun activityOf(ctx: Context): Activity? {
        var c: Context? = ctx
        while (c is ContextWrapper) {
            if (c is Activity) return c
            c = c.baseContext
        }
        return null
    }

    private fun wireDelegates(
        session: GeckoSession,
        view: GeckoView,
        runtime: GeckoRuntime,
        appCtx: Context,
        vm: BouncerViewModel,
    ) {
        session.navigationDelegate = navigationDelegate(appCtx, vm)
        session.progressDelegate = progressDelegate(vm)
        session.contentDelegate = contentDelegate(runtime, vm, view, appCtx)
        session.scrollDelegate = scrollDelegate(vm)
        session.permissionDelegate = permissionDelegate(appCtx)
    }

    // x.com's "turn on push notifications" toggle requests the
    // desktop-notification content permission (also implied by
    // pushManager.subscribe). Gecko persists the answer per-origin, and
    // background pushes are silently dropped without a stored ALLOW — so tie
    // the grant to the Android 13+ POST_NOTIFICATIONS runtime permission the
    // notifications actually need. Everything else keeps the pre-existing
    // no-delegate behavior (deny) by returning null.
    private fun permissionDelegate(appCtx: Context) =
        object : GeckoSession.PermissionDelegate {
            override fun onContentPermissionRequest(
                session: GeckoSession,
                perm: GeckoSession.PermissionDelegate.ContentPermission,
            ): GeckoResult<Int>? {
                if (perm.permission !=
                    GeckoSession.PermissionDelegate.PERMISSION_DESKTOP_NOTIFICATION
                ) {
                    return null
                }
                val result = GeckoResult<Int>()
                NotificationPermissionBroker.ensurePermission(appCtx) { granted ->
                    Log.i(TAG, "notification permission for ${perm.uri}: granted=$granted")
                    result.complete(
                        if (granted) {
                            GeckoSession.PermissionDelegate.ContentPermission.VALUE_ALLOW
                        } else {
                            GeckoSession.PermissionDelegate.ContentPermission.VALUE_DENY
                        },
                    )
                }
                return result
            }
        }

    private fun navigationDelegate(appCtx: Context, vm: BouncerViewModel) =
        object : GeckoSession.NavigationDelegate {
            override fun onLocationChange(
                session: GeckoSession,
                url: String?,
                perms: MutableList<GeckoSession.PermissionDelegate.ContentPermission>,
                hasUserGesture: Boolean,
            ) {
                // Only the visible tab drives the address/dropdown + login/prompt
                // logic; a warm background tab navigating must not touch it.
                if (isActiveSession(session)) vm.onUrlChanged(url.orEmpty())
            }

            override fun onCanGoBack(session: GeckoSession, canGoBack: Boolean) {
                if (isActiveSession(session)) vm.setCanGoBack(canGoBack)
            }

            override fun onCanGoForward(session: GeckoSession, canGoForward: Boolean) {
                if (isActiveSession(session)) vm.setCanGoForward(canGoForward)
            }

            override fun onLoadRequest(
                session: GeckoSession,
                request: GeckoSession.NavigationDelegate.LoadRequest,
            ): GeckoResult<AllowOrDeny>? {
                val uri = Uri.parse(request.uri)
                val host = uri.host?.lowercase().orEmpty()
                val allowed = ALLOWED_HOSTS.any { host == it || host.endsWith(".$it") }
                if (allowed) return GeckoResult.allow()
                if (request.hasUserGesture) {
                    openExternal(appCtx, uri)
                    return GeckoResult.deny()
                }
                return GeckoResult.allow()
            }

            override fun onNewSession(
                session: GeckoSession,
                uri: String,
            ): GeckoResult<GeckoSession>? {
                val parsed = Uri.parse(uri)
                // Google sign-in must stay in-process: a Custom Tab is a separate
                // browser context, so the OAuth popup can't deliver its result
                // back to the opener window and the login silently fails.
                if (isGoogleSignIn(parsed)) {
                    val popup = GeckoSession()
                    popup.navigationDelegate = popupNavigationDelegate(appCtx)
                    popup.contentDelegate = popupContentDelegate(vm)
                    vm.attachPopupSession(popup)
                    return GeckoResult.fromValue(popup)
                }
                openExternal(appCtx, parsed)
                return GeckoResult.fromValue(null)
            }
        }

    private fun isGoogleSignIn(uri: Uri): Boolean {
        val host = uri.host?.lowercase() ?: return false
        return host == "accounts.google.com" || host.endsWith(".accounts.google.com") ||
            host == "accounts.youtube.com" || host.endsWith(".accounts.youtube.com")
    }

    private fun popupNavigationDelegate(appCtx: Context) =
        object : GeckoSession.NavigationDelegate {
            override fun onLoadRequest(
                session: GeckoSession,
                request: GeckoSession.NavigationDelegate.LoadRequest,
            ): GeckoResult<AllowOrDeny>? {
                val uri = Uri.parse(request.uri)
                val host = uri.host?.lowercase().orEmpty()
                val allowed = ALLOWED_HOSTS.any { host == it || host.endsWith(".$it") }
                if (allowed) return GeckoResult.allow()
                if (request.hasUserGesture) {
                    openExternal(appCtx, uri)
                    return GeckoResult.deny()
                }
                return GeckoResult.allow()
            }
        }

    private fun popupContentDelegate(vm: BouncerViewModel) =
        object : GeckoSession.ContentDelegate {
            override fun onCloseRequest(session: GeckoSession) {
                vm.closePopup()
            }
        }

    private fun progressDelegate(vm: BouncerViewModel) =
        object : GeckoSession.ProgressDelegate {
            override fun onPageStart(session: GeckoSession, url: String) {
                Log.i(TAG, "start: $url")
            }
            override fun onPageStop(session: GeckoSession, success: Boolean) {
                Log.i(TAG, "stop: success=$success")
                if (isActiveSession(session)) vm.onPageStop()
            }
            override fun onSessionStateChange(
                session: GeckoSession,
                state: GeckoSession.SessionState,
            ) {
                // savedState feeds crash recovery, which recovers the visible
                // tab — so only track the active session's state.
                if (isActiveSession(session)) vm.onSessionStateChanged(state)
            }
        }

    // Gecko discards backgrounded content processes under memory pressure.
    // When that happens, on resume the View paints flat gray until we attach
    // a fresh session and reload — otherwise the user is stuck until force-quit.
    private fun contentDelegate(
        runtime: GeckoRuntime,
        vm: BouncerViewModel,
        view: GeckoView,
        appCtx: Context,
    ) = object : GeckoSession.ContentDelegate {
        override fun onKill(session: GeckoSession) {
            Log.w(TAG, "onKill fired (active=${isActiveSession(session)})")
            onSessionDied(session, view, vm, runtime, appCtx)
        }
        override fun onCrash(session: GeckoSession) {
            Log.w(TAG, "onCrash fired (active=${isActiveSession(session)})")
            onSessionDied(session, view, vm, runtime, appCtx)
        }
        // Diagnostic: these are what should lift the coverUntilFirstPaint cover.
        // If a user reports a stuck-gray screen, grep logcat for "FF/Gecko: first":
        // absence of these lines during a stuck episode confirms the cover-stuck
        // hypothesis (cover applied, but Gecko never produced a paint).
        override fun onFirstComposite(session: GeckoSession) {
            Log.i(TAG, "firstComposite")
        }
        override fun onFirstContentfulPaint(session: GeckoSession) {
            Log.i(TAG, "firstContentfulPaint")
        }
    }

    // Called by the lifecycle observer on ON_RESUME. Handles two cases:
    //  - onKill fired while backgrounded → pendingRecovery was set, do it now
    //    while the SurfaceView has a live surface.
    //  - onKill was never delivered (some OEMs sever the IPC channel silently
    //    when killing child processes of backgrounded apps), but the session
    //    is closed → still recover.
    fun recoverIfNeeded(view: GeckoView, vm: BouncerViewModel) {
        val r = runtime ?: return
        val session = vm.mainSession()
        val needsByPending = pendingRecovery
        val needsByState = session != null && !session.isOpen()
        if (!needsByPending && !needsByState) return
        Log.i(
            TAG,
            "recoverIfNeeded: triggering (pending=$needsByPending, !isOpen=$needsByState)",
        )
        pendingRecovery = false
        performRecovery(view, vm, r, view.context.applicationContext)
    }

    // A content process died. If it was the visible tab, rebuild it (below).
    // If it was a warm background tab, just forget it — the next switch will
    // recreate it fresh (switchToPlatform only reuses `isOpen` sessions).
    private fun onSessionDied(
        session: GeckoSession,
        view: GeckoView,
        vm: BouncerViewModel,
        runtime: GeckoRuntime,
        appCtx: Context,
    ) {
        if (isActiveSession(session)) {
            scheduleRecovery(view, vm, runtime, appCtx)
        } else {
            sessions.entries.firstOrNull { it.value === session }?.let { sessions.remove(it.key) }
        }
    }

    private fun scheduleRecovery(
        view: GeckoView,
        vm: BouncerViewModel,
        runtime: GeckoRuntime,
        appCtx: Context,
    ) {
        if (!activityForegrounded) {
            Log.i(TAG, "scheduleRecovery: activity not foregrounded; deferring")
            pendingRecovery = true
            return
        }
        performRecovery(view, vm, runtime, appCtx)
    }

    // ON_RESUME may arrive before the SurfaceView's surface is fully attached;
    // calling setSession at that exact moment can leave the new session with
    // no compositor target, the cover never lifts, and the user is stuck on
    // a gray view until rotation forces a fresh activity. Posting onto the
    // view's message queue runs after the next traversal, when the surface is
    // guaranteed live.
    private fun performRecovery(
        view: GeckoView,
        vm: BouncerViewModel,
        runtime: GeckoRuntime,
        appCtx: Context,
    ) {
        Log.i(TAG, "performRecovery: scheduling on view.post")
        view.post { performRecoveryNow(view, vm, runtime, appCtx) }
    }

    private fun performRecoveryNow(
        view: GeckoView,
        vm: BouncerViewModel,
        runtime: GeckoRuntime,
        appCtx: Context,
    ) {
        Log.i(TAG, "performRecoveryNow: start")
        val newSession = GeckoSession()
        wireDelegates(newSession, view, runtime, appCtx, vm)
        newSession.open(runtime)
        // Replace the dead active tab in the cache + rebind the bridge so
        // routing follows the rebuilt session.
        sessions[activePlatformId] = newSession
        bridge?.setActivePlatform(activePlatformId)
        // setSession before coverUntilFirstPaint — see comment in create().
        view.setSession(newSession)
        reapplyDynamicToolbar(view)
        if (coverColor != 0) view.coverUntilFirstPaint(coverColor)
        vm.attachSession(newSession)
        newSession.setActive(true)
        val state = vm.savedSessionState
        if (state != null) {
            Log.i(TAG, "performRecoveryNow: restoreState")
            newSession.restoreState(state)
        } else {
            val url = vm.currentUrlOrInitial()
            Log.i(TAG, "performRecoveryNow: loadUri=$url")
            newSession.loadUri(url)
        }
    }

    private fun scrollDelegate(vm: BouncerViewModel) =
        object : GeckoSession.ScrollDelegate {
            override fun onScrollChanged(session: GeckoSession, scrollX: Int, scrollY: Int) {
                if (isActiveSession(session)) vm.onScroll(scrollY)
            }
        }

    private fun openExternal(ctx: Context, url: Uri) {
        runCatching {
            val scheme = url.scheme?.lowercase()
            if (scheme == "http" || scheme == "https") {
                val intent = CustomTabsIntent.Builder().build()
                intent.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                intent.launchUrl(ctx, url)
            } else {
                val intent = Intent(Intent.ACTION_VIEW, url)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx.startActivity(intent)
            }
        }.onFailure { Log.w(TAG, "openExternal failed for $url", it) }
    }
}
