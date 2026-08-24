//
//  DeviceActivityMonitorExtension.swift
//  BouncerActivityMonitor
//
//  The clock on the engage window, and the thing that taps you on the shoulder
//  while it runs.
//
//  iOS launches this process when a threshold is crossed, gives it a very small
//  amount of memory and a very short time, and takes it away again. That budget
//  is why nothing here builds a UI, decodes an image, or talks to a server: it
//  reads two numbers out of the App Group, posts a notification or puts a
//  shield back, and stops.
//
//  WHY A NOTIFICATION AND NOT A SHIELD, for the check-in.
//
//  Both are available. Re-applying the shield mid-session would drop a wall in
//  front of whatever they were doing, and it works — that is how Screen Time's
//  own limits interrupt. It is also the behaviour that gets these apps deleted.
//  A check-in is a question, and a question you cannot decline is not one; the
//  shield would make "are you still here for this?" rhetorical.
//
//  So the check-in is a notification. It can be ignored. Nothing follows from
//  ignoring it. The only thing that actually closes the door is the window
//  ending, which was agreed to in advance and announced when it was opened.
//

import DeviceActivity
import FamilyControls
import Foundation
import ManagedSettings

class DeviceActivityMonitorExtension: DeviceActivityMonitor {

    override func eventDidReachThreshold(
        _ event: DeviceActivityEvent.Name,
        activity: DeviceActivityName
    ) {
        super.eventDidReachThreshold(event, activity: activity)
        guard activity == Gate.activity else { return }

        // Check-ins only. There is deliberately no event here that puts the
        // shield back: see GateSchedule.events. The door closing is not
        // something that happens TO someone mid-session.
        if let second = GateSchedule.checkInSecond(from: event) {
            // Only while the window is actually open. A threshold can arrive
            // just after the window closed by another route, and a check-in for
            // a session that has already ended is a notification about nothing.
            guard Gate.isSessionOpen else { return }
            GateNotifications.postCheckIn(secondsUsed: second)
        }
    }

    /// The holding schedule lapsed. Stop watching and put the door back.
    ///
    /// This is the one place the shield is re-applied from an extension, and it
    /// is safe to do here in a way it would not be mid-session: two hours have
    /// passed since they went through, so the odds of dropping a shield over
    /// somebody's open conversation are as low as this API can make them. The
    /// other re-arm happens in the app, on foreground — see
    /// `GateController.reconcile`.
    ///
    /// Silent, unlike the old window-closed notification. Nothing was taken
    /// away: the next time they open X they are asked what they are
    /// there for, which is the normal state of the gate rather than an event
    /// worth interrupting them to announce.
    override func intervalDidEnd(for activity: DeviceActivityName) {
        super.intervalDidEnd(for: activity)
        guard activity == Gate.activity else { return }

        Gate.sessionOpenedAt = nil
        DeviceActivityCenter().stopMonitoring([Gate.activity])

        guard Gate.isArmed, let selection = Gate.selection else { return }
        let store = Gate.store
        store.shield.applications = selection.applicationTokens.isEmpty
            ? nil
            : selection.applicationTokens
        store.shield.applicationCategories = selection.categoryTokens.isEmpty
            ? nil
            : .specific(selection.categoryTokens)
        // Apps only. Shielding the web domain would shield x.com inside
        // Bouncer, which is where the gate wants them.
        Gate.clearWebShield()
    }
}
