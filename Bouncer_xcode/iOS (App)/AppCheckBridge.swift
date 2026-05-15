//
//  AppCheckBridge.swift
//  iOS (App)
//
//  Initializes Firebase + App Check and provides tokens to the JS layer.
//

import Firebase
import FirebaseAppCheck
import FirebaseCrashlytics

class AppCheckBridge {
    static let shared = AppCheckBridge()

    /// True once Firebase has been successfully configured with a bundled
    /// GoogleService-Info plist. When false, every Imbue-backed path (App
    /// Check tokens, WebSocket pipeline, AI text detection) is unavailable
    /// and the UI must fall back to BYOK providers.
    private(set) var isAvailable: Bool = false

    private init() {}

    /// Call once at app launch, before any token requests.
    func configure() {
        let env = Bundle.main.object(forInfoDictionaryKey: "BouncerEnv") as? String ?? "PROD"
        let plistName = (env == "DEV") ? "GoogleService-Info-Dev" : "GoogleService-Info"

        // Open-source / BYOK-only builds ship without a GoogleService-Info
        // plist. Skip Firebase entirely instead of crashing — the rest of
        // the app reads `isAvailable` and degrades gracefully.
        guard let path = Bundle.main.path(forResource: plistName, ofType: "plist"),
              let options = FirebaseOptions(contentsOfFile: path) else {
            print("[AppCheck] \(plistName).plist not found — running without Firebase / Imbue backend")
            isAvailable = false
            return
        }

        AppCheck.setAppCheckProviderFactory(BouncerAppCheckProviderFactory())
        FirebaseApp.configure(options: options)
        Crashlytics.crashlytics().setCustomValue(plistName, forKey: "firebase_env")
        isAvailable = true
        print("[AppCheck] Firebase configured with App Check using \(plistName).plist")
    }

    /// Get a fresh App Check token. Returns nil on failure or when Firebase
    /// wasn't configured (no plist shipped).
    func getToken() async -> String? {
        guard isAvailable else { return nil }
        do {
            let result = try await AppCheck.appCheck().token(forcingRefresh: false)
            return result.token
        } catch {
            print("[AppCheck] Failed to get token: \(error.localizedDescription)")
            return nil
        }
    }
}
