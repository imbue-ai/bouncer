package com.imbue.bouncer.state

data class BouncerUiState(
    // Which platform's tab is displayed. This — not a parse of currentUrl —
    // drives the NavBar's platform label: currentUrl can legitimately be a
    // URL that maps to no platform (Google auth) or momentarily to the wrong
    // one, and parsing it with a Twitter fallback left the label stuck on X.
    val activePlatformId: String = "twitter",
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
    // A top-level document load failed (e.g. no network at launch). GeckoView
    // renders NOTHING on a failed load — without this flag the user would sit
    // on a blank white view that reads as a frozen app. Drives the native
    // offline/error overlay in BouncerApp; cleared by retry or the next
    // successful page load.
    val loadFailed: Boolean = false,
)
