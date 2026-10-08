package com.imbue.bouncer

import android.app.ActivityManager
import android.app.Application
import android.content.res.Configuration
import android.os.Build
import android.os.Process
import android.util.Log
import com.imbue.bouncer.analytics.Analytics
import com.imbue.bouncer.web.AppCheckBridge
import com.imbue.bouncer.web.BouncerGeckoView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

class BouncerApplication : Application() {
    lateinit var appCheck: AppCheckBridge
        private set

    // Lives for the lifetime of the main process — used by the runtime warmup
    // and the long-lived bridge / WebSocket plumbing.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    override fun onCreate() {
        super.onCreate()
        // GeckoView is multi-process: Android instantiates this Application
        // class in every Gecko child process too. Skip heavy init outside the
        // main process. https://github.com/mozilla-mobile/fenix/issues/13658
        val proc = currentProcessName()
        if (proc != packageName) {
            Log.i(TAG, "skipping init in non-main process: $proc")
            return
        }
        appCheck = AppCheckBridge(this).also { it.configure() }
        Analytics.init(this)
        // Snapshot notification enablement every launch — it drifts outside the
        // app (system-settings mute, permission revocation).
        Analytics.refreshNotificationStatus(this)
        if (BuildConfig.DEBUG) {
            com.imbue.bouncer.push.PushSubscriptionStore(this).dumpToLog(TAG)
        }
        // The GeckoRuntime is deliberately NOT warmed here. Application.onCreate
        // runs for every main-process start, including the ones Android does
        // purely to deliver a push broadcast or run a Firebase Analytics upload
        // job. Booting Gecko (plus its gpu/socket/utility/content children) on
        // each of those was the app's dominant background battery cost. The
        // runtime is warmed from MainActivity.onCreate instead, so Gecko only
        // runs when there's a screen to show; push is rendered natively
        // (NativePushHandler) and never needs the browser.
    }

    /**
     * Boots the GeckoRuntime (idempotent; main thread). Called from
     * MainActivity.onCreate — the one process-start path that needs a browser.
     */
    fun warmUpGecko() {
        BouncerGeckoView.warmUp(applicationContext, scope, appCheck)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        BouncerGeckoView.onConfigurationChanged(this)
    }

    private fun currentProcessName(): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return getProcessName()
        val am = getSystemService(ACTIVITY_SERVICE) as ActivityManager
        val pid = Process.myPid()
        return am.runningAppProcesses?.firstOrNull { it.pid == pid }?.processName.orEmpty()
    }

    companion object {
        private const val TAG = "BouncerApp"
    }
}
