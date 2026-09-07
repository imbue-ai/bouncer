package com.imbue.bouncer

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
import com.imbue.bouncer.push.NotificationPermissionBroker
import com.imbue.bouncer.push.WebNotificationHandler
import com.imbue.bouncer.state.BouncerViewModel
import com.imbue.bouncer.ui.BouncerApp
import com.imbue.bouncer.ui.theme.BouncerTheme
import com.imbue.bouncer.web.BouncerGeckoView
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

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        // Hold the system splash until the GeckoRuntime + WebExtension install
        // resolve (kicked off in BouncerApplication.onCreate). Avoids a black,
        // unresponsive activity during the first composition.
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
        handleWebNotificationClick(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleWebNotificationClick(intent)
    }

    override fun onDestroy() {
        if (NotificationPermissionBroker.requester != null && !isChangingConfigurations) {
            NotificationPermissionBroker.requester = null
        }
        super.onDestroy()
    }

    // A tapped web notification carries the parcelable WebNotification; calling
    // click() fires notificationclick in the site's service worker, which opens
    // the right page via the ServiceWorkerDelegate.
    private fun handleWebNotificationClick(intent: Intent?) {
        if (intent?.action != WebNotificationHandler.ACTION_CLICK) return
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
        // click() makes Gecko fire notificationclick in the site's service
        // worker; the SW's clients.openWindow lands in our ServiceWorkerDelegate,
        // which needs an open session. On a cold start the session is created in
        // the first composition, so wait for it (bounded — the 5s budget between
        // click and openWindow is enforced by Gecko on its own side).
        lifecycleScope.launch {
            var waited = 0L
            while (viewModel.mainSession() == null && waited < CLICK_SESSION_WAIT_MS) {
                delay(100)
                waited += 100
            }
            notification.click()
        }
    }

    private companion object {
        const val CLICK_SESSION_WAIT_MS = 5_000L
    }
}
