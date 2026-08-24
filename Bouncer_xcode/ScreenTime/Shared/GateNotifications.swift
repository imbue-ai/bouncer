//
//  GateNotifications.swift
//  Shared by the app and the extensions that need to speak to the user.
//
//  Local notifications are doing two different jobs here, and it is worth
//  separating them because they justify themselves differently.
//
//  THE HANDOFF is a mechanism, not a message. An app extension cannot launch an
//  app — there is no `UIApplication` to ask — so when someone taps "watch
//  in Bouncer" on the shield, a notification is the only thing that can
//  carry them to Bouncer. It should therefore be as close to invisible as a
//  notification can be: it exists to be tapped immediately, and its text is a
//  label on a door rather than something to read.
//
//  THE CHECK-IN is a message and nothing else. Nothing happens if it is
//  ignored, which is the entire reason it is a notification instead of a shield
//  thrown over the app mid-scroll. A shield would be an interruption the user
//  cannot decline; this is a question they can.
//

import Foundation
import UserNotifications

public enum GateNotifications {

    /// Ask once. Called from the app — an extension cannot prompt, it can only
    /// post, so if this was never granted the shield's second button silently
    /// does nothing and the gate is broken in a way that looks like a bug.
    /// The UI checks `isAuthorized` before letting the gate be armed.
    public static func requestAuthorization() async -> Bool {
        let center = UNUserNotificationCenter.current()
        do {
            return try await center.requestAuthorization(options: [.alert, .sound])
        } catch {
            return false
        }
    }

    public static func isAuthorized() async -> Bool {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: return true
        default: return false
        }
    }

    /// Post immediately. `nil` delay means "as soon as iOS will allow", which
    /// for a local notification is the next runloop or so — fast enough that
    /// the handoff feels like part of the tap that caused it.
    private static func post(
        id: String,
        title: String,
        body: String,
        route: String?,
        after seconds: TimeInterval?,
        completion: (() -> Void)? = nil
    ) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.categoryIdentifier = Gate.Notify.category
        if let route {
            content.userInfo = [Gate.Notify.routeKey: route]
        }

        // A nil trigger fires the notification straight away, including while
        // the app that posted it is being torn down — which is exactly the
        // situation the handoff is posted in.
        let trigger: UNNotificationTrigger? = seconds.map {
            UNTimeIntervalNotificationTrigger(timeInterval: max(1, $0), repeats: false)
        }
        let request = UNNotificationRequest(identifier: id, content: content, trigger: trigger)

        // `add` is ASYNCHRONOUS — it hands the request to the notification
        // daemon over XPC and returns immediately. In an app extension that is
        // the difference between a notification and no notification: the caller
        // signals it is finished, iOS tears the process down, and a request
        // still in flight goes with it. Callers that have a completion handler
        // to hold open must wait for this one.
        UNUserNotificationCenter.current().add(request) { _ in
            guard let completion else { return }
            DispatchQueue.main.async(execute: completion)
        }
    }

    /// The bridge from the shield to Bouncer. Text kept to a label: this is
    /// meant to be tapped on sight, and anything longer is read instead.
    /// `completion` fires once the request has actually been accepted.
    ///
    /// The shield action extension must not answer iOS until then. It used to
    /// answer immediately — the whole reason the second button did nothing:
    /// the process was gone before the request landed, so the tap dismissed
    /// the shield and no notification ever arrived.
    public static func postHandoff(completion: @escaping () -> Void) {
        Gate.lastHandoffAt = Date()
        // Forced to disk for the same reason the shield stamps are: this
        // process is about to be killed, and a write still in memory dies here.
        Gate.defaults.synchronize()
        post(
            id: Gate.Notify.handoffID,
            title: "Open in Bouncer",
            body: "Tap to open your viewer.",
            route: Gate.Notify.routeTwitter,
            after: nil,
            completion: completion
        )
    }

    /// The check-in. Phrased as a question with a real answer, because it has
    /// one: ignoring it is allowed and nothing follows from it.
    ///
    /// Fire-and-forget, unlike the handoff, because its caller has nothing to
    /// hold open: `DeviceActivityMonitor.eventDidReachThreshold` is handed no
    /// completion handler, so there is no supported way to keep that process
    /// alive until the request lands. In practice the monitor is not torn down
    /// as abruptly as a shield action, which answers iOS explicitly.
    ///
    /// Seconds rather than minutes so the DEBUG-only sub-minute step has
    /// something honest to say; whole minutes still read as minutes.
    public static func postCheckIn(secondsUsed: Int) {
        let elapsed = secondsUsed % 60 == 0
            ? "\(secondsUsed / 60) minute\(secondsUsed == 60 ? "" : "s")"
            : "\(secondsUsed) seconds"
        post(
            id: "\(Gate.Notify.checkInID).\(secondsUsed)",
            title: "\(elapsed) in",
            body: "Still what you came for? Tap to switch to your Bouncer viewer.",
            route: Gate.Notify.routeTwitter,
            after: nil
        )
    }

    /// Clear anything we have posted. Called when the gate is disarmed, so a
    /// stale check-in cannot arrive after the feature has been turned off.
    public static func clearAll() {
        let center = UNUserNotificationCenter.current()
        center.removeAllDeliveredNotifications()
        center.removeAllPendingNotificationRequests()
    }
}
