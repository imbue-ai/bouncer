package com.imbue.bouncer.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SheetState
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import com.imbue.bouncer.BouncerApplication
import com.imbue.bouncer.state.BouncerViewModel
import com.imbue.bouncer.web.BouncerGeckoView
import kotlinx.coroutines.MainScope
import org.mozilla.geckoview.GeckoView
import kotlin.math.roundToInt

// Material 3 BottomAppBar's default container height (BottomAppBarDefaults.ContainerHeight).
private val NAV_BAR_CONTENT_HEIGHT = 80.dp

// Unwrap the Activity from the Compose LocalContext (usually a ContextThemeWrapper).
private fun Context.findActivity(): Activity? {
    var c: Context? = this
    while (c is ContextWrapper) {
        if (c is Activity) return c
        c = c.baseContext
    }
    return null
}

// Captured-once system bar inset measurements (status bar height + gesture
// pill / nav bar inset). Held in pixels so we can feed them into Gecko's
// dynamic-toolbar math without round-tripping through Dp.
private data class StaticSysBarInsets(val topPx: Int, val bottomPx: Int)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun BouncerApp(viewModel: BouncerViewModel = viewModel()) {
    val state by viewModel.state.collectAsState()
    val imeVisible = WindowInsets.isImeVisible
    val navBarEffectivelyVisible = state.navBarVisible && !imeVisible

    if (!state.hasCompletedOnboarding) {
        Onboarding(onDone = viewModel::completeOnboarding)
        return
    }

    BackHandler(enabled = state.canGoBack) {
        viewModel.goBack()
    }

    val ctx = LocalContext.current
    val app = ctx.applicationContext as BouncerApplication
    val scope = remember { MainScope() }
    // Used by both initial paint and post-recovery cover so the brief gap
    // between a fresh session attaching and the first paint shows the theme
    // color instead of GeckoView's default gray.
    val coverColor = MaterialTheme.colorScheme.background.toArgb()
    val geckoView = remember {
        BouncerGeckoView.create(ctx, scope, viewModel, app.appCheck, coverColor)
    }
    // Keep BouncerGeckoView's cover color in sync if the theme palette changes
    // after the GeckoView is constructed (e.g. light/dark switch).
    LaunchedEffect(coverColor) {
        BouncerGeckoView.setCoverColor(coverColor)
    }

    // Hold the screen on while an auto-enable is in flight: the off-screen
    // settings render is throttled (~30s) and Gecko suspends rendering entirely
    // if the screen sleeps, which would strand the enable. Cleared as soon as the
    // toggle is clicked+subscribed (the backend POST finishes without a screen).
    val activity = remember(ctx) { ctx.findActivity() }
    LaunchedEffect(state.pushEnableInProgress) {
        val window = activity?.window ?: return@LaunchedEffect
        if (state.pushEnableInProgress) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> {
                    BouncerGeckoView.setActivityForegrounded(true)
                    viewModel.setSessionActive(true)
                    viewModel.onAppForegrounded()
                    // If onKill fired in background (or was never delivered
                    // but the content process is dead), rebuild the session
                    // now that the SurfaceView has a live surface to render to.
                    BouncerGeckoView.recoverIfNeeded(geckoView, viewModel)
                }
                Lifecycle.Event.ON_PAUSE -> {
                    BouncerGeckoView.setActivityForegrounded(false)
                    viewModel.setSessionActive(false)
                }
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val density = LocalDensity.current

    // Capture status-bar + gesture-pill insets exactly once into a
    // non-reactive snapshot. The AndroidView wrapping the GeckoView is
    // padded by these values as static Dp; once captured, the snapshot
    // never changes (within this activity instance), so the AndroidView's
    // bounds are stable for the lifetime of the activity. That's the only
    // safe pattern: any inset-reactive Modifier on the GeckoView's
    // AndroidView triggers SurfaceView.setFrame → GeckoSession.onSurfaceChanged
    // → synchronous main-thread JNI wait into Gecko's GPU IPC, which ANRs
    // on resume when the GPU child process is just-thawed from the
    // cached-app freezer. See feedback_geckoview_androidview_stable_bounds.
    //
    // IME is excluded (systemBars = statusBars + navigationBars). We don't
    // want the keyboard to push the GeckoView up/down for the same reason.
    //
    // While the snapshot is null (typically 0–2 frames at first launch),
    // the AndroidView isn't rendered; the Box background colors the
    // screen so the user just sees the theme color momentarily.
    //
    // Tradeoff: if the user toggles gesture-vs-button nav (or otherwise
    // changes the static system-bar inset) while the app is running,
    // we won't pick it up until the next activity recreation. Rotation
    // recreates the activity → fresh capture → correct values.
    val staticInsets = remember { mutableStateOf<StaticSysBarInsets?>(null) }
    if (staticInsets.value == null) {
        val topPx = WindowInsets.systemBars.getTop(density)
        val bottomPx = WindowInsets.systemBars.getBottom(density)
        LaunchedEffect(topPx, bottomPx) {
            if (topPx > 0 || bottomPx > 0) {
                staticInsets.value = StaticSysBarInsets(topPx, bottomPx)
            }
        }
    }

    val sysNavInsetPx = staticInsets.value?.bottomPx ?: 0
    val barContentHeightPx = with(density) { NAV_BAR_CONTENT_HEIGHT.toPx() }
    // Total slide distance includes the system-nav inset so the bar slides
    // fully past the gesture pill area when hidden.
    val totalBarHeightPx = barContentHeightPx + sysNavInsetPx

    // Tell Gecko the maximum the dynamic toolbar can ever cover. This makes
    // the page's initial containing block static (so dvh/svh/lvh resolve as
    // if the bar were present), which is the prerequisite that lets
    // setVerticalClipping animate position:fixed-bottom elements without
    // reflowing the whole page each frame. The GeckoView is inset above
    // the gesture pill via the static padding below, so we only reserve
    // barContentHeightPx — the NavBar content's overlap over the
    // GeckoView's bounds.
    // Route through BouncerGeckoView (not geckoView directly) so it remembers
    // this value and re-applies it after every setSession() swap — otherwise a
    // platform switch or crash recovery resets the compositor's dynamic-toolbar
    // height to 0 and x.com's fixed bottom bar drops behind our nav bar.
    LaunchedEffect(geckoView, barContentHeightPx) {
        BouncerGeckoView.setDynamicToolbarMaxHeight(barContentHeightPx.roundToInt())
    }

    // Single source of truth for the bar's vertical offset. graphicsLayer
    // consumes it for cheap draw-time translation; the snapshotFlow below
    // pipes the same value into Gecko's clipping so page-internal sticky
    // bottom bars (e.g. Twitter's tab bar) track our nav bar's top edge
    // smoothly. This is what Fenix does for its own browser chrome.
    val translationYAnim = animateFloatAsState(
        targetValue = if (navBarEffectivelyVisible) 0f else totalBarHeightPx,
        animationSpec = tween(durationMillis = 220, easing = FastOutSlowInEasing),
        label = "navBarTranslation",
    )

    LaunchedEffect(geckoView, barContentHeightPx) {
        snapshotFlow { translationYAnim.value }
            .collect { y ->
                // Per Fenix's EngineViewClippingBehavior: pass -translationY,
                // clamped to the reserved bar area so we never report more
                // clipping than was reserved via setDynamicToolbarMaxHeight.
                // Once the NavBar slides past barContentHeightPx it's no
                // longer overlapping the GeckoView (it's moving through the
                // gesture-pill padded area), so the clip stays at -max.
                val clip = -y.coerceIn(0f, barContentHeightPx).roundToInt()
                // Via BouncerGeckoView so the latest clip is stored and replayed
                // onto whatever session is attached after a setSession() swap.
                BouncerGeckoView.setVerticalClipping(clip)
            }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        // GeckoView's AndroidView must have stable bounds for the activity's
        // lifetime — any bounds change re-fires GeckoSession.onSurfaceChanged
        // which synchronously waits on Gecko's GPU IPC and ANRs on resume.
        // We use the once-captured systemBars snapshot above and apply it as
        // static Dp padding: the values are read once and never change again,
        // so the AndroidView is the same size every recomposition. This is
        // visually equivalent to windowInsetsPadding(safeDrawing) (minus IME)
        // but without the reactivity that causes the freeze.
        staticInsets.value?.let { ins ->
            val topDp = with(density) { ins.topPx.toDp() }
            val bottomDp = with(density) { ins.bottomPx.toDp() }
            AndroidView(
                factory = { geckoView },
                modifier = Modifier
                    .fillMaxSize()
                    .padding(top = topDp, bottom = bottomDp),
            )
        }
        // Native offline/error view for a failed top-level load. GeckoView
        // renders nothing on load failure, so without this the user sits on a
        // blank white view that reads as a frozen app (Play review rejected
        // v11 for exactly that). Drawn UNDER the NavBar so reload stays
        // reachable; swallows touches so the dead page beneath isn't
        // interactable. Cleared by retry, by the NavBar reload, or
        // automatically when connectivity returns (BouncerViewModel).
        if (state.loadFailed) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(MaterialTheme.colorScheme.background)
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                    ) {},
                contentAlignment = Alignment.Center,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        text = "Can't connect",
                        style = MaterialTheme.typography.headlineSmall,
                        color = MaterialTheme.colorScheme.onBackground,
                    )
                    Spacer(Modifier.height(12.dp))
                    Text(
                        text = "Check your internet connection.\nBouncer will retry automatically.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onBackground,
                        textAlign = TextAlign.Center,
                    )
                    Spacer(Modifier.height(24.dp))
                    Button(onClick = viewModel::retryLoad) {
                        Text("Try again")
                    }
                }
            }
        }
        NavBar(
            currentUrl = state.currentUrl,
            filteredCount = state.filteredCount,
            onReload = viewModel::reload,
            onSelectPlatform = { BouncerGeckoView.switchToPlatform(it) },
            onBouncerClick = { viewModel.setSheetPresented(true) },
            showBouncerTooltip = state.reachedTimeline && !state.hasSeenBouncerTooltip,
            onBouncerTooltipDismissed = viewModel::markBouncerTooltipSeen,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .graphicsLayer { translationY = translationYAnim.value }
                .windowInsetsPadding(
                    WindowInsets.navigationBars.only(WindowInsetsSides.Bottom),
                ),
        )

        // Opaque cover shown while we briefly display x.com's push-settings page
        // on the real webview to auto-enable notifications (a surfaceless
        // background tab won't render it cold). Fills the whole screen — over the
        // webview AND the nav bar — and swallows touches so the user can't
        // interact with the settings page underneath.
        if (state.pushEnableCoverVisible) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(MaterialTheme.colorScheme.background)
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                    ) {},
                contentAlignment = Alignment.Center,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator(color = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.height(20.dp))
                    Text(
                        text = "Turning on notifications…",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onBackground,
                    )
                }
            }
        }
    }

    if (state.popupActive) {
        val popup = viewModel.popupSession()
        if (popup != null) {
            Dialog(
                onDismissRequest = { viewModel.closePopup() },
                properties = DialogProperties(usePlatformDefaultWidth = false),
            ) {
                AndroidView(
                    factory = { c ->
                        GeckoView(c).apply { setSession(popup) }
                    },
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }

    if (state.isSheetPresented) {
        // Default M3 positionalThreshold is 56.dp — that's how far the user
        // has to drag from one anchor before the sheet commits to the next
        // state. Lowering it to 24.dp makes a short upward swipe enough to
        // jump from partial to expanded (and a short downward swipe to
        // dismiss). Velocity threshold stays at the default 125.dp/s.
        val density = LocalDensity.current
        val sheetPositionalThreshold: () -> Float = remember(density) {
            { with(density) { 24.dp.toPx() } }
        }
        val sheetVelocityThreshold: () -> Float = remember(density) {
            { with(density) { 125.dp.toPx() } }
        }
        val sheetState = rememberSaveable(
            saver = SheetState.Saver(
                skipPartiallyExpanded = false,
                positionalThreshold = sheetPositionalThreshold,
                velocityThreshold = sheetVelocityThreshold,
                confirmValueChange = { true },
                skipHiddenState = false,
            ),
        ) {
            SheetState(
                skipPartiallyExpanded = false,
                positionalThreshold = sheetPositionalThreshold,
                velocityThreshold = sheetVelocityThreshold,
                initialValue = SheetValue.Hidden,
                confirmValueChange = { true },
                skipHiddenState = false,
            )
        }
        ModalBottomSheet(
            onDismissRequest = { viewModel.setSheetPresented(false) },
            sheetState = sheetState,
            dragHandle = { BottomSheetDefaults.DragHandle() },
        ) {
            FilterSheet(
                sheetState = sheetState,
                phrases = state.phrases,
                filteredCount = state.filteredCount,
                aiDetectionOn = state.aiDetectionOn,
                aiDetectionPending = state.aiDetectionPending,
                filterReplies = state.filterReplies,
                notificationsEnabled = state.notificationsEnabled,
                onAdd = viewModel::addPhrase,
                onRemove = viewModel::removePhrase,
                onViewFiltered = viewModel::openFilteredModal,
                onShareFilterPack = viewModel::shareFilterPack,
                onToggleAiDetection = viewModel::toggleAiDetection,
                onFilterRepliesChange = viewModel::setFilterReplies,
                onNotificationsEnabledChange = viewModel::setNotificationsEnabled,
                modifier = Modifier.imePadding(),
            )
        }
    }
}
