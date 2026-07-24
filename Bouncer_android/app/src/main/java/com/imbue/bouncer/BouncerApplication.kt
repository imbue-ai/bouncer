package com.imbue.bouncer

import android.app.ActivityManager
import android.app.Application
import android.content.res.Configuration
import android.os.Build
import android.os.Process
import android.util.Log
import com.imbue.bouncer.inference.LocalInferenceService
import com.imbue.bouncer.web.AppCheckBridge
import com.imbue.bouncer.web.BouncerGeckoView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

class BouncerApplication : Application() {
    lateinit var appCheck: AppCheckBridge
        private set

    lateinit var localInference: LocalInferenceService
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
        localInference = LocalInferenceService(applicationContext, scope)
        // Pay the GeckoRuntime cost here (still main thread, but during process
        // startup where there's no input-dispatch deadline) instead of on the
        // first composition. The splash screen covers the wall-clock gap.
        BouncerGeckoView.warmUp(applicationContext, scope, appCheck, localInference)
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
