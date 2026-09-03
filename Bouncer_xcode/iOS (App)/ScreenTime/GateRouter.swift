//
//  GateRouter.swift
//  iOS (App)
//
//  The far end of the handoff.
//
//  Someone tapped "View in Bouncer" on a shield, a notification was posted
//  by an extension that could not open us itself, and they tapped that. This is
//  where they land — and the one thing that must not happen is landing on the
//  platform picker, because the whole sequence was a person saying which
//  platform they wanted before Bouncer was even running.
//

import Foundation
internal import Combine
import UserNotifications

@MainActor
final class GateRouter: ObservableObject {

    static let shared = GateRouter()

    /// A platform id waiting to be navigated to, or nil. Cleared by whoever
    /// consumes it — a route acted on twice would push a second copy of the
    /// feed onto the stack.
    @Published var pendingPlatform: String?

    private init() {}

    func route(to platform: String) {
        pendingPlatform = platform
    }

    /// Pull the route out of a notification, if it carries one.
    func handle(userInfo: [AnyHashable: Any]) {
        guard let platform = userInfo[Gate.Notify.routeKey] as? String else { return }
        route(to: platform)
    }

    func consume() -> String? {
        defer { pendingPlatform = nil }
        return pendingPlatform
    }
}

/// Receives notification taps. Registered by the app delegate; kept separate
/// from it so the routing rule is readable in one place rather than buried in
/// launch bookkeeping.
final class GateNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {

    static let shared = GateNotificationDelegate()

    func install() {
        UNUserNotificationCenter.current().delegate = self
    }

    /// Show check-ins even while Bouncer is open.
    ///
    /// It reads odd at first — why tell someone to come here when they are
    /// here? Because the window they are being asked about is a window into
    /// ANOTHER app, and the two are open at the same time more often than not:
    /// they replied to a message, came back, and the clock is still running.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        Task { @MainActor in
            GateRouter.shared.handle(userInfo: userInfo)
            completionHandler()
        }
    }
}
