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

    private init() {}

    /// Call once at app launch, before any token requests.
    func configure() {
        AppCheck.setAppCheckProviderFactory(BouncerAppCheckProviderFactory())

        let env = Bundle.main.object(forInfoDictionaryKey: "BouncerEnv") as? String ?? "PROD"
        let plistName = (env == "DEV") ? "GoogleService-Info-Dev" : "GoogleService-Info"

        guard let path = Bundle.main.path(forResource: plistName, ofType: "plist"),
              let options = FirebaseOptions(contentsOfFile: path) else {
            fatalError("[AppCheck] Missing \(plistName).plist in bundle")
        }
        FirebaseApp.configure(options: options)
        Crashlytics.crashlytics().setCustomValue(plistName, forKey: "firebase_env")
        print("[AppCheck] Firebase configured with App Check using \(plistName).plist")
    }

    /// Get a fresh App Check token. Returns nil on failure.
    func getToken() async -> String? {
        do {
            let result = try await AppCheck.appCheck().token(forcingRefresh: false)
            return result.token
        } catch {
            print("[AppCheck] Failed to get token: \(error.localizedDescription)")
            return nil
        }
    }
}
