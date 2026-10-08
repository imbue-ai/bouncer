package com.imbue.bouncer

import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import com.imbue.bouncer.push.NativePushHandler
import com.imbue.bouncer.push.NotificationPermissionBroker
import com.imbue.bouncer.push.WebNotificationHandler
import com.imbue.bouncer.state.BouncerViewModel
import com.imbue.bouncer.state.Platforms
import com.imbue.bouncer.ui.BouncerApp
import com.imbue.bouncer.ui.theme.BouncerTheme
import com.imbue.bouncer.web.BouncerGeckoView
import com.imbue.bouncer.web.FilePromptBroker
import org.mozilla.geckoview.WebNotification

class MainActivity : ComponentActivity() {

    private val viewModel: BouncerViewModel by viewModels {
        ViewModelProvider.AndroidViewModelFactory.getInstance(application)
    }

    // One in-flight callback at a time is enough: the only caller is the Gecko
    // permission delegate, which is serialized behind a single user gesture.
    private var pendingPermissionCallback: ((Boolean) -> Unit)? = null
    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            pendingPermissionCallback?.invoke(granted)
            pendingPermissionCallback = null
        }

    // Same single-flight shape for the Gecko file prompt (<input type="file">):
    // one picker at a time, serialized behind a user gesture in the page.
    private var pendingFilePickCallback: ((Int, Intent?) -> Unit)? = null
    private val filePickerLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            pendingFilePickCallback?.invoke(result.resultCode, result.data)
            pendingFilePickCallback = null
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        // Boot Gecko here rather than in Application.onCreate: this is the one
        // process-start path that needs a browser (push wakeups and Firebase
        // jobs don't, and used to pay for a full Gecko boot each time). Still
        // the main thread, still before the first composition; the splash
        // below covers the gap. Idempotent on activity re-creates.
        (application as BouncerApplication).warmUpGecko()
        // Hold the system splash until the GeckoRuntime + WebExtension install
        // resolve. Avoids a black, unresponsive activity during the first
        // composition.
        splash.setKeepOnScreenCondition { !BouncerGeckoView.isReady() }
        super.onCreate(savedInstanceState)
        // Match Firefox: fully transparent system nav bar with no scrim, so the
        // BottomAppBar's surface color reads continuously into the gesture/3-button
        // strip instead of being overlaid by the default light/dark scrim.
        enableEdgeToEdge(
            navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
        )
        // On API 29+ the system enforces a translucent contrast scrim behind the
        // 3-button nav whenever the nav bar background is transparent. That scrim
        // tints whatever the app draws underneath (visible as a purple/gray cast).
        // Disabling it lets the app's own color show through unaltered.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isNavigationBarContrastEnforced = false
        }
        setContent {
            BouncerTheme {
                BouncerApp(viewModel = viewModel)
            }
        }
        NotificationPermissionBroker.requester = { onResult ->
            pendingPermissionCallback = onResult
            notificationPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
        FilePromptBroker.launcher = { pickIntent, onResult ->
            pendingFilePickCallback = onResult
            try {
                filePickerLauncher.launch(pickIntent)
            } catch (e: ActivityNotFoundException) {
                pendingFilePickCallback = null
                onResult(RESULT_CANCELED, null)
            }
        }
        handleNotificationIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleNotificationIntent(intent)
    }

    override fun onDestroy() {
        if (!isChangingConfigurations) {
            if (NotificationPermissionBroker.requester != null) {
                NotificationPermissionBroker.requester = null
            }
            // The BouncerGeckoView singleton outlives this Activity; drop its
            // references to our GeckoView/ViewModel so the Activity graph can
            // be collected. On a config change the refs are about to be
            // replaced by the next create(), so leave them for continuity.
            BouncerGeckoView.onActivityDestroyed()
        }
        if (FilePromptBroker.launcher != null && !isChangingConfigurations) {
            FilePromptBroker.launcher = null
        }
        super.onDestroy()
    }

    // Notification taps. A native push notification (NativePushHandler) carries
    // the x.com URL to open. A Gecko-raised notification carries the parcelable
    // WebNotification; calling click() fires notificationclick in the site's
    // service worker, which opens the right page via the ServiceWorkerDelegate.
    private fun handleNotificationIntent(intent: Intent?) {
        when (intent?.action) {
            NativePushHandler.ACTION_OPEN_URL -> {
                val url = intent.getStringExtra(NativePushHandler.EXTRA_URL) ?: return
                // Consume so a config change doesn't re-fire the navigation.
                intent.removeExtra(NativePushHandler.EXTRA_URL)
                whenSessionReady { openNotificationUrl(url) }
            }
            WebNotificationHandler.ACTION_CLICK -> {
                intent.setExtrasClassLoader(WebNotification::class.java.classLoader)
                val notification: WebNotification? = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(
                        WebNotificationHandler.EXTRA_NOTIFICATION,
                        WebNotification::class.java,
                    )
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(WebNotificationHandler.EXTRA_NOTIFICATION)
                }
                // Consume so a config change doesn't re-fire the click.
                intent.removeExtra(WebNotificationHandler.EXTRA_NOTIFICATION)
                if (notification == null) return
                // The 5s budget between click and openWindow is enforced by
                // Gecko on its own side.
                whenSessionReady { notification.click() }
            }
        }
    }

    // Route the tap into the platform's own tab (switching to it if LinkedIn
    // is up), falling back to a plain load for URLs that map to no platform.
    private fun openNotificationUrl(url: String) {
        val platform = Platforms.fromUrl(url)
        if (platform != null) {
            BouncerGeckoView.switchToPlatform(platform, url)
        } else {
            viewModel.navigateTo(url)
        }
    }

    // On a cold start the session is created in the first composition, so wait
    // for it (bounded) before driving navigation.
    private fun whenSessionReady(block: () -> Unit) {
        lifecycleScope.launch {
            var waited = 0L
            while (viewModel.mainSession() == null && waited < CLICK_SESSION_WAIT_MS) {
                delay(100)
                waited += 100
            }
            block()
        }
    }

    private companion object {
        const val CLICK_SESSION_WAIT_MS = 5_000L
    }
}
