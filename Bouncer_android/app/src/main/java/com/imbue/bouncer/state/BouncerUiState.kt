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
    val hasSeenBouncerTooltip: Boolean = false,
    val popupActive: Boolean = false,
    val navBarVisible: Boolean = true,
)
