//
//  GatePermissions.swift
//  iOS (App)
//
//  The two system permissions the gate needs, in the three states the UI cares
//  about — and the fact that only two of those three can be repaired from
//  inside the app.
//
//  A denial is the state that matters. iOS will not show the same prompt
//  twice, so "Allow" is a dead button after a refusal: the only repair is
//  Settings. Offering it inline, at the moment we detect the denial, is the
//  difference between a recoverable mistake and a feature the user concludes
//  is broken.
//

import SwiftUI
import UserNotifications

enum PermissionState { case notAsked, granted, denied }

/// The only repair available for a refused prompt.
enum SystemSettings {
    static func open() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

/// Notification authorization, in the three states the UI cares about.
enum NotificationPermission {
    case unknown, notAsked, granted, denied

    var permissionState: PermissionState {
        switch self {
        case .granted: return .granted
        case .denied: return .denied
        default: return .notAsked
        }
    }

    static func current() async -> NotificationPermission {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: return .granted
        case .denied: return .denied
        case .notDetermined: return .notAsked
        @unknown default: return .unknown
        }
    }
}
