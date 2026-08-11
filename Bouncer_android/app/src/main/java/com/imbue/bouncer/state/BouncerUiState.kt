package com.imbue.bouncer.state

data class BouncerUiState(
    val phrases: List<String> = emptyList(),
    val filteredCount: Int = 0,
    val themeMode: String = "dark",
    val canGoBack: Boolean = false,
    val canGoForward: Boolean = false,
    val currentUrl: String = "",
    val isSheetPresented: Boolean = false,
    val isFilteredModalOpen: Boolean = false,
    // AI detection (text + images, one signal) has no manual on/off switch —
    // it is driven entirely by the user's natural-language filter phrases
    // (see the extension's background/ai-intent.ts). `aiDetectionOn` mirrors
    // that derived state; `aiDetectionPending` dims the sheet's sparkle
    // indicator while the backend round trip that follows a tap is in
    // flight — the counterpart of the desktop indicator's `.pending` class
    // and the iOS sheet's `aiDetectionPending`.
    val aiDetectionOn: Boolean = false,
    val aiDetectionPending: Boolean = false,
    val filterReplies: Boolean = true,
    val hasCompletedOnboarding: Boolean = false,
    val hasLoggedIn: Boolean = false,
    // Set once we actually observe the /home timeline this session — the
    // authoritative "logged in and browsing" signal. Unlike the persisted
    // hasLoggedIn (which Auto Backup can restore stale), this can't be true on
    // the login screen, so UI gated on it (the bouncer tooltip) won't misfire.
    val reachedTimeline: Boolean = false,
    val hasSeenBouncerTooltip: Boolean = false,
    val popupActive: Boolean = false,
    val navBarVisible: Boolean = true,
    // While true, an opaque "Turning on notifications…" cover hides the webview:
    // the covered fallback displays x.com's push-settings page on the real surface
    // to enable push, and we don't want that settings page to flash by.
    val pushEnableCoverVisible: Boolean = false,
    // True while an auto-enable attempt is running (off-screen render → click →
    // subscribe). Drives KEEP_SCREEN_ON so the phone doesn't sleep mid-render
    // (the off-screen render is throttled and takes ~30s), and gates the settings
    // "Turn on notifications" button.
    val pushEnableInProgress: Boolean = false,
    // Whether x.com push is subscribed (drives the settings button's state).
    val notificationsEnabled: Boolean = false,
)
