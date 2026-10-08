//
//  AppDelegate.swift
//  iOS (App)
//
//  Created by Darren Jia on 2/12/26.
//

import UIKit
import TipKit
import UserNotifications

@main
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        AppCheckBridge.shared.configure()
        try? Tips.configure([.displayFrequency(.immediate)])
        // Touch the downloader singleton at launch so its background
        // URLSession is bound to the delegate before iOS tries to
        // deliver any pending events for our session identifier.
        _ = ModelDownloader.shared
        // Web Push: taps on relayed x.com notifications come back through the
        // notification-center delegate (must be set before launch finishes so
        // a cold-start tap is delivered), and an already-authorized install
        // re-registers for its APNs token so the relay mapping stays fresh.
        UNUserNotificationCenter.current().delegate = self
        PushRegistrar.shared.applicationDidLaunch()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushRegistrar.shared.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushRegistrar.shared.didFailToRegister(error: error)
    }

    // Background / content-available pushes (anything without a visible
    // alert) land here instead of the notification center. Logged so push
    // delivery experiments can see exactly what arrived.
    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        print("[WebPush] remote notification delivered to app: \(Self.describe(userInfo))")
        completionHandler(.noData)
    }

    static func describe(_ userInfo: [AnyHashable: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: userInfo, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return "\(userInfo)" }
        return text
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        return UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }

    // iOS calls this when relaunching the app to deliver background
    // URLSession events (download finished, error, etc.) for a session
    // whose `sessionSendsLaunchEvents` is true. We stash the system
    // completion handler on the downloader; it's invoked once
    // urlSessionDidFinishEvents fires.
    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        guard identifier == ModelDownloader.sessionIdentifier else {
            completionHandler()
            return
        }
        ModelDownloader.shared.backgroundEventsCompletionHandler = completionHandler
    }
}

// MARK: - Notification taps / foreground display

extension AppDelegate: UNUserNotificationCenterDelegate {
    // Show relayed pushes even while the app is in front; the user may be on
    // LinkedIn or a profile page, not on x.com's notifications tab.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let content = notification.request.content
        let decrypted = content.userInfo[PushRegistrar.userInfoURLKey] != nil
        print("[WebPush] push arrived while foreground: title=\"\(content.title)\" decrypted=\(decrypted) thread=\(content.threadIdentifier) userInfo=\(Self.describe(content.userInfo))")
        return [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        print("[WebPush] notification tapped: url=\(userInfo[PushRegistrar.userInfoURLKey] ?? "none")")
        await MainActor.run {
            PushRegistrar.shared.handleNotificationTap(userInfo: userInfo)
        }
    }
}
