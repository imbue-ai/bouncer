//
//  AppConstants.swift
//  iOS (App)
//
//  UserDefaults keys for the app target's own flags. Gate/Screen Time keys
//  live in Gate.Key (ScreenTime/Shared/Gate.swift); these are app-only.
//  Values are the historical literals — do not rename, they're already on
//  users' devices.
//

import Foundation

enum DefaultsKey {
    /// Set by OnboardingView on finish; @AppStorage-observed to show/hide it.
    static let hasCompletedOnboarding = "hasCompletedOnboarding"
    /// Set when the X webview first reaches the home feed.
    static let hasLoggedIn = "hasLoggedIn"
    /// The Instagram intro tour plays once ever — this is the "ever".
    static let hasArmedInstagramIntro = "hasArmedInstagramIntro"
    /// Scroll-study capture toggle, persisted across launches.
    static let scrollStudyCaptureEnabled = "scrollStudyCaptureEnabled"
}
