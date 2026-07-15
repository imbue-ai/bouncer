package com.imbue.bouncer

import android.graphics.Color
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.ViewModelProvider
import com.imbue.bouncer.state.BouncerViewModel
import com.imbue.bouncer.ui.BouncerApp
import com.imbue.bouncer.ui.theme.BouncerTheme
import com.imbue.bouncer.web.BouncerGeckoView

class MainActivity : ComponentActivity() {

    private val viewModel: BouncerViewModel by viewModels {
        ViewModelProvider.AndroidViewModelFactory.getInstance(application)
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
    }
}
