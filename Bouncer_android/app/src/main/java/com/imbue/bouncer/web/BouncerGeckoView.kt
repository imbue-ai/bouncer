package com.imbue.bouncer.web

import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.util.Log
import androidx.browser.customtabs.CustomTabsIntent
import com.imbue.bouncer.BouncerApplication
import com.imbue.bouncer.inference.LocalInferenceService
import com.imbue.bouncer.state.BouncerViewModel
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

    private val ALLOWED_HOSTS = setOf(
        "x.com", "twitter.com", "t.co",
        "twimg.com", "pbs.twimg.com", "abs.twimg.com", "video.twimg.com",
        "accounts.google.com", "accounts.youtube.com", "google.com", "gstatic.com",
    )

    @Volatile private var runtime: GeckoRuntime? = null
    @Volatile private var installResult: GeckoResult<WebExtension>? = null
    @Volatile private var bridge: GeckoBridge? = null
    @Volatile private var ready: Boolean = false

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

    fun isReady(): Boolean = ready

    fun setActivityForegrounded(foregrounded: Boolean) {
        activityForegrounded = foregrounded
    }

    fun setCoverColor(color: Int) {
        coverColor = color
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
    fun warmUp(
        appCtx: Context,
        scope: CoroutineScope,
        appCheck: AppCheckBridge,
        localInference: LocalInferenceService,
    ) {
        if (runtime != null) return
        synchronized(this) {
            if (runtime != null) return
            val settings = GeckoRuntimeSettings.Builder()
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
                .build()
            val r = GeckoRuntime.create(appCtx, settings)
            val b = GeckoBridge(appCtx, scope, appCheck, localInference)
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

    fun create(
        ctx: Context,
        scope: CoroutineScope,
        vm: BouncerViewModel,
        appCheck: AppCheckBridge,
        coverColor: Int,
    ): GeckoView {
        val appCtx = ctx.applicationContext
        // Defensive: should already be warm via Application.onCreate.
        warmUp(appCtx, scope, appCheck, (appCtx as BouncerApplication).localInference)
        val r = runtime!!
        bridge?.let { vm.attachBridge(it) }
        this.coverColor = coverColor

        val view = GeckoView(ctx)
        val session = GeckoSession()
        wireDelegates(session, view, r, appCtx, vm)
        session.open(r)
        // setSession before coverUntilFirstPaint: the cover-listener binds against
        // the GeckoView's current compositor state, and we want it bound to the
        // session that will actually produce the next paint. If we cover first,
        // the listener can end up waiting on a paint event that no longer arrives.
        view.setSession(session)
        if (coverColor != 0) view.coverUntilFirstPaint(coverColor)
        vm.attachSession(session)

        val initialUrl = vm.initialUrl()
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
    }

    private fun navigationDelegate(appCtx: Context, vm: BouncerViewModel) =
        object : GeckoSession.NavigationDelegate {
            override fun onLocationChange(
                session: GeckoSession,
                url: String?,
                perms: MutableList<GeckoSession.PermissionDelegate.ContentPermission>,
                hasUserGesture: Boolean,
            ) {
                vm.onUrlChanged(url.orEmpty())
            }

            override fun onCanGoBack(session: GeckoSession, canGoBack: Boolean) {
                vm.setCanGoBack(canGoBack)
            }

            override fun onCanGoForward(session: GeckoSession, canGoForward: Boolean) {
                vm.setCanGoForward(canGoForward)
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
                vm.onPageStop()
            }
            override fun onSessionStateChange(
                session: GeckoSession,
                state: GeckoSession.SessionState,
            ) {
                vm.onSessionStateChanged(state)
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
            Log.w(TAG, "onKill fired")
            scheduleRecovery(view, vm, runtime, appCtx)
        }
        override fun onCrash(session: GeckoSession) {
            Log.w(TAG, "onCrash fired")
            scheduleRecovery(view, vm, runtime, appCtx)
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
        // setSession before coverUntilFirstPaint — see comment in create().
        view.setSession(newSession)
        if (coverColor != 0) view.coverUntilFirstPaint(coverColor)
        vm.attachSession(newSession)
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
                vm.onScroll(scrollY)
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
