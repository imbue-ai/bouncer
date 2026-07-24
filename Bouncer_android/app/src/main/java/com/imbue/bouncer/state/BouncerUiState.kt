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
    val aiTextFilterEnabled: Boolean = false,
    val aiTextDetectionThreshold: Double = 0.7,
    // The extension's selectedModel storage key: "imbue" (cloud, default when
    // empty) or "iosLocal:<model-id>" (on-device).
    val selectedModel: String = "",
    val hasCompletedOnboarding: Boolean = false,
    val hasLoggedIn: Boolean = false,
    val hasSeenBouncerTooltip: Boolean = false,
    val popupActive: Boolean = false,
    val navBarVisible: Boolean = true,
)
