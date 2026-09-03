//
//  GateSchedule.swift
//  Shared by the app, the shield action, and the activity monitor.
//
//  Turning "ten minutes of use" into something Device Activity will agree to
//  watch.
//
//  Two things about the API shape the whole of this file:
//
//  A SCHEDULE IS A CLOCK WINDOW, and it has a fifteen-minute floor. So the
//  engage window cannot be a schedule — a five-minute one is not expressible,
//  and a wall-clock one would drain while the phone was face-down on a table.
//
//  AN EVENT IS A USAGE THRESHOLD, measured from the start of the schedule it
//  lives in, and it fires once. So the window and its check-ins are events: a
//  ladder of thresholds inside one long schedule that exists only to hold them.
//  Usage is the right unit anyway — the promise made on the shield is "ten
//  minutes of the real app", and that is what this measures.
//

import Foundation

#if os(iOS)
import DeviceActivity
import FamilyControls
import ManagedSettings

public enum GateSchedule {

    /// How long the holding schedule runs for. Long enough that a window is
    /// never cut short by the schedule ending under it, short enough that a
    /// session forgotten about does not leave monitoring running all day.
    /// Crossing midnight is fine — Device Activity supports a wrapping
    /// interval, which is how everybody's Downtime works.
    private static let horizon: TimeInterval = 2 * 60 * 60

    public static func schedule(from now: Date = Date(),
                                calendar: Calendar = .current) -> DeviceActivitySchedule {
        let start = calendar.dateComponents([.hour, .minute, .second], from: now)
        let end = calendar.dateComponents([.hour, .minute, .second],
                                          from: now.addingTimeInterval(horizon))
        return DeviceActivitySchedule(intervalStart: start, intervalEnd: end, repeats: false)
    }

    /// The ladder: a check-in every `Gate.checkInStepSeconds` of use, for as
    /// long as the holding schedule runs.
    ///
    /// NOTHING HERE CLOSES THE DOOR. There used to be a window-end event that
    /// put the shield back after an agreed number of minutes, and it was the
    /// wrong instrument: a shield dropped over an app somebody is mid-sentence
    /// in is an interruption they cannot decline, which is the behaviour that
    /// gets these apps deleted. The door closes on its own the next time they
    /// leave and come back — the shield is re-applied whenever Bouncer is
    /// foregrounded and when the schedule lapses — and in between, the only
    /// thing that reaches them is a notification they are free to ignore.
    ///
    /// Thresholds are in use of the gated apps specifically — not screen time in
    /// general — so the clock only runs while they are in the place the check-in
    /// is asking about.
    ///
    /// Built in seconds rather than minutes only because the DEBUG check-in step
    /// is sub-minute and would otherwise round to nothing. Be warned that iOS
    /// samples usage on roughly a minute's granularity, so a ten-second
    /// threshold fires *approximately*, not on the ten-second mark — good enough
    /// to watch the mechanism work, not a timer.
    public static func events(
        for selection: FamilyActivitySelection
    ) -> [DeviceActivityEvent.Name: DeviceActivityEvent] {
        var events: [DeviceActivityEvent.Name: DeviceActivityEvent] = [:]

        func event(seconds: Int) -> DeviceActivityEvent {
            DeviceActivityEvent(
                applications: selection.applicationTokens,
                categories: selection.categoryTokens,
                // No web domains: the gate shields apps only, so counting time
                // on x.com toward the ladder would spend check-ins on
                // the one place the shield is happy for them to be — including
                // the minutes they spend inside Bouncer.
                webDomains: [],
                threshold: DateComponents(second: seconds)
            )
        }

        // Laddered across the whole holding schedule rather than a window,
        // because there is no window any more. `maxCheckIns` is what bounds it.
        for second in Gate.checkInSeconds(inWindowOf: Int(horizon)) {
            events[Gate.checkInEvent(second: second)] = event(seconds: second)
        }
        return events
    }

    /// Which check-in an event name refers to, in seconds, or nil if it is not
    /// one. The monitor gets a name back and has to work out what it meant;
    /// encoding the mark in the name is the only channel available for that.
    public static func checkInSecond(from name: DeviceActivityEvent.Name) -> Int? {
        let prefix = "gate.checkIn."
        guard name.rawValue.hasPrefix(prefix) else { return nil }
        return Int(name.rawValue.dropFirst(prefix.count))
    }

    /// Start watching. Returns the error if Device Activity refused, which is
    /// worth surfacing rather than swallowing: a refusal here means the engage
    /// window has no way to close itself, and the caller may want to decline to
    /// open one at all.
    @discardableResult
    public static func startMonitoring(selection: FamilyActivitySelection) -> Error? {
        let center = DeviceActivityCenter()
        // Stop first: starting an activity that is already running throws, and
        // a stale one from an abandoned session is exactly what would be.
        center.stopMonitoring([Gate.activity])
        do {
            try center.startMonitoring(
                Gate.activity,
                during: schedule(),
                events: events(for: selection)
            )
            return nil
        } catch {
            return error
        }
    }
}
#endif
