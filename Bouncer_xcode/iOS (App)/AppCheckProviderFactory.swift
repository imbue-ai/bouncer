//
//  AppCheckProviderFactory.swift
//  iOS (App)
//
//  Configures Firebase App Check attestation provider.
//  Uses App Attest on real devices (iOS 14+), Debug provider on simulators.
//

import Firebase
import FirebaseAppCheck

class BouncerAppCheckProviderFactory: NSObject, AppCheckProviderFactory {
    func createProvider(with app: FirebaseApp) -> AppCheckProvider? {
        #if targetEnvironment(simulator)
        let provider = AppCheckDebugProvider(app: app)
        if let token = provider?.localDebugToken() {
            print("[AppCheck] Debug token: \(token)")
            print("[AppCheck] Register this token in Firebase Console > App Check > Manage debug tokens")
        }
        return provider
        #else
        if #available(iOS 14.0, *) {
            return AppAttestProvider(app: app)
        } else {
            return DeviceCheckProvider(app: app)
        }
        #endif
    }
}
