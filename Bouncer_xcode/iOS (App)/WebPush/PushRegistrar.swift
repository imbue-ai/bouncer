//
//  PushRegistrar.swift
//  iOS (App)
//
//  Native side of Web Push for the in-app x.com web view. Answers the page's
//  pushManager calls (via WebPushBridge) with keys this app holds, owns the
//  APNs token, keeps the relay's token mapping fresh, and routes notification
//  taps into the web view. The iOS counterpart of Android's PushRegistrar +
//  BouncerPushDelegate.
//
//  Flow: page calls subscribe(applicationServerKey) → we make sure the user
//  has granted notifications and we hold an APNs token → generate P-256 keys
//  + auth secret → PUT the token to the relay under a fresh subscription id →
//  store the record in the shared Keychain → return {endpoint, keys} to the
//  page, which posts them to x.com's backend exactly as it would in Chrome.
//

import CryptoKit
import Foundation
import UIKit
import UserNotifications

@MainActor
final class PushRegistrar {
    static let shared = PushRegistrar()

    /// Posted (on main) when a notification tap wants the web view on a URL.
    /// Object is the URL.
    static let openURLNotification = Notification.Name("BouncerPushOpenURL")
    static let userInfoURLKey = "bouncerURL"

    private(set) var deviceTokenHex: String?
    private var tokenWaiters: [CheckedContinuation<String?, Never>] = []
    private var pendingOpenURL: URL?

    private init() {}

    // MARK: - App lifecycle

    /// Called from didFinishLaunching. If the user already granted
    /// notifications, re-register for a (possibly rotated) APNs token; the
    /// token callback then refreshes every subscription at the relay.
    func applicationDidLaunch() {
        guard PushRelayClient.isConfigured else { return }
        Task { @MainActor in
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    func didRegister(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        let changed = hex != deviceTokenHex
        deviceTokenHex = hex
        resumeTokenWaiters(with: hex)
        print("[WebPush] APNs token \(changed ? "updated" : "unchanged") (\(Self.apnsEnvironment()))")
        #if DEBUG
        // Debug builds only: the raw token, for push-delivery experiments.
        print("[WebPush] APNs token hex (\(Self.apnsEnvironment())): \(hex)")
        #endif
        Task { await refreshRegistrations() }
    }

    func didFailToRegister(error: Error) {
        print("[WebPush] APNs registration failed: \(error)")
        resumeTokenWaiters(with: nil)
    }

    /// Re-PUT every stored subscription with the current token. Cheap, and it
    /// is what keeps the relay's mapping alive (its records expire if an app
    /// hasn't launched in months) and current across token rotations.
    func refreshRegistrations() async {
        guard let token = deviceTokenHex else { return }
        for record in PushSubscriptionStore.all() {
            do {
                _ = try await PushRelayClient.register(
                    subscriptionId: record.id,
                    deviceTokenHex: token,
                    environment: Self.apnsEnvironment(),
                    appServerKey: record.appServerKey
                )
            } catch {
                print("[WebPush] refresh failed for \(record.scope): \(error)")
            }
        }
    }

    // MARK: - Page-facing operations (called by WebPushBridge)

    func subscribe(scope: String, appServerKey: Data?) async -> PushSubscriptionRecord? {
        guard PushRelayClient.isConfigured else {
            print("[WebPush] subscribe refused: relay URL not configured")
            return nil
        }
        guard let appServerKey, appServerKey.count == 65, appServerKey.first == 0x04 else {
            // The relay authenticates senders against the VAPID key bound at
            // registration; a keyless subscription can't be delivered to.
            print("[WebPush] subscribe without a VAPID key unsupported: \(scope)")
            return nil
        }
        guard await ensureAuthorized() else {
            print("[WebPush] subscribe refused: notifications not authorized")
            return nil
        }
        guard let token = await awaitDeviceToken() else {
            print("[WebPush] subscribe refused: no APNs token")
            return nil
        }

        // A re-subscribe replaces the old record; the site treats the new
        // endpoint as authoritative once it posts it to its backend.
        if let old = PushSubscriptionStore.get(scope: scope) {
            try? await PushRelayClient.unregister(subscriptionId: old.id)
        }
        let id = Self.newSubscriptionId()
        let keyPair = WebPushCrypto.generateKeyPair()
        do {
            let endpoint = try await PushRelayClient.register(
                subscriptionId: id,
                deviceTokenHex: token,
                environment: Self.apnsEnvironment(),
                appServerKey: appServerKey
            )
            let record = PushSubscriptionRecord(
                id: id,
                scope: scope,
                endpoint: endpoint,
                appServerKey: appServerKey,
                publicKey: WebPushCrypto.uncompressedPoint(keyPair),
                privateKey: keyPair.rawRepresentation,
                authSecret: WebPushCrypto.generateAuthSecret(),
                createdAt: Date()
            )
            try PushSubscriptionStore.save(record)
            print("[WebPush] subscribed \(scope) → \(endpoint)")
            return record
        } catch {
            print("[WebPush] subscribe failed for \(scope): \(error)")
            return nil
        }
    }

    func getSubscription(scope: String) -> PushSubscriptionRecord? {
        PushSubscriptionStore.get(scope: scope)
    }

    func unsubscribe(scope: String) async -> Bool {
        guard let record = PushSubscriptionStore.get(scope: scope) else { return false }
        PushSubscriptionStore.remove(scope: scope)
        try? await PushRelayClient.unregister(subscriptionId: record.id)
        print("[WebPush] unsubscribed \(scope)")
        return true
    }

    /// Web-platform permission state for the page's Notification/permissionState.
    func permissionState() async -> String {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: return "granted"
        case .denied: return "denied"
        default: return "prompt"
        }
    }

    // MARK: - Notification taps

    /// From UNUserNotificationCenterDelegate. The service extension puts the
    /// resolved x.com URL in userInfo; a push it couldn't decrypt has none, so
    /// fall back to the notifications page like the site's own worker does.
    func handleNotificationTap(userInfo: [AnyHashable: Any]) {
        let url = (userInfo[Self.userInfoURLKey] as? String).flatMap(URL.init(string:))
            ?? PushPayload.resolveClickURL(nil)
        open(url)
    }

    private func open(_ url: URL) {
        pendingOpenURL = url
        NotificationCenter.default.post(name: Self.openURLNotification, object: url)
    }

    /// For a cold launch: the view hierarchy doesn't exist yet when the tap
    /// arrives, so the container asks for it once it's mounted.
    func consumePendingOpenURL() -> URL? {
        defer { pendingOpenURL = nil }
        return pendingOpenURL
    }

    // MARK: - Permission + token

    private func ensureAuthorized() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return true
        case .notDetermined:
            // The system prompt appears right where Safari would show its
            // own — when the site asks.
            let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            return granted
        default:
            return false
        }
    }

    private func awaitDeviceToken(timeout: TimeInterval = 15) async -> String? {
        if let token = deviceTokenHex { return token }
        UIApplication.shared.registerForRemoteNotifications()
        return await withCheckedContinuation { (cont: CheckedContinuation<String?, Never>) in
            tokenWaiters.append(cont)
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                // Timed out (or never answered): release whoever is still waiting.
                self.resumeTokenWaiters(with: self.deviceTokenHex)
            }
        }
    }

    private func resumeTokenWaiters(with token: String?) {
        let waiters = tokenWaiters
        tokenWaiters.removeAll()
        waiters.forEach { $0.resume(returning: token) }
    }

    private static func newSubscriptionId() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return "sub_" + Data(bytes).base64urlString
    }

    /// Which APNs gateway this build's tokens belong to. Xcode-installed
    /// builds carry a provisioning profile with aps-environment=development
    /// (sandbox); TestFlight/App Store builds use production. The relay keeps
    /// one SNS platform application per gateway.
    static func apnsEnvironment() -> String {
        #if targetEnvironment(simulator)
        return "sandbox"
        #else
        // App Store builds ship no embedded profile → production.
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1) else {
            return "production"
        }
        let pattern = #"<key>aps-environment</key>\s*<string>(\w+)</string>"#
        if let re = try? NSRegularExpression(pattern: pattern),
           let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
           let r = Range(m.range(at: 1), in: text) {
            return text[r] == "development" ? "sandbox" : "production"
        }
        return "production"
        #endif
    }
}
