//
//  GateTokens.swift
//  Shared by the app, the shield action and the activity monitor — but NOT by
//  the shield configuration extension.
//
//  The half of `Gate` that needs Apple's Screen Time frameworks: the opaque
//  tokens for what the user picked, the settings store the shield lives in, and
//  the Device Activity names the engage window is measured with.
//
//  It is a separate file for one reason. A shield configuration extension is
//  launched to answer a single question — what should this screen say — with a
//  memory budget small enough that loading FamilyControls, ManagedSettings and
//  DeviceActivity in order to answer it is a real risk of being killed first.
//  A killed configuration extension is invisible: iOS quietly draws its own
//  default shield, which is indistinguishable from a feature that was never
//  built. Keeping the heavy half out of that target's Compile Sources is what
//  makes the light half genuinely light.
//

import Foundation

#if os(iOS)
import FamilyControls
import ManagedSettings
import DeviceActivity

extension Gate {

    /// One line of state, for the Xcode console. The gate has four processes
    /// and three system permissions between a tap and a shield; when it does
    /// nothing at all, the useful question is which of them is missing.
    public static func report(authorization: String) -> String {
        var parts: [String] = []
        parts.append("appGroup=\(appGroupResolved ? "ok" : "MISSING")")
        parts.append("screenTime=\(authorization)")
        parts.append("armed=\(isArmed)")
#if os(iOS)
        let selection = self.selection
        let apps = selection?.applicationTokens.count ?? 0
        let cats = selection?.categoryTokens.count ?? 0
        parts.append("picked=\(apps) app(s), \(cats) categor(ies)")
        parts.append("shielding=\(store.shield.applications?.count ?? 0) app(s)")
        // Should always be zero. A non-zero count here is x.com being
        // blocked inside Bouncer's own WebView, which presents as the feed
        // simply refusing to load.
        parts.append("webShield=\(store.shield.webDomains?.count ?? 0)")
#endif
        parts.append("engageWindow=\(isSessionOpen ? "OPEN" : "closed")")
        func ago(_ date: Date?) -> String {
            guard let date else { return "NEVER" }
            return "\(Int(Date().timeIntervalSince(date)))s ago"
        }
        parts.append("shieldDrawn=\(ago(lastShieldRenderAt))")
        parts.append("shieldTapped=\(ago(lastShieldActionAt))")
        // The three explanations for a hand-off that never arrived, separated:
        // NEVER (the button did not run), REFUSED (the daemon rejected it), or
        // accepted (it was posted, and something downstream — a Focus mode,
        // notifications off for the app — chose not to show it).
        parts.append("handoff=\(lastHandoffAt == nil ? "NEVER" : (lastHandoffResult ?? "posted"))")
        if let at = lastHandoffAt { parts.append("handoffAt=\(ago(at))") }
        let step = checkInStepSeconds
        let checkIn = step == 0 ? "off"
            : step % 60 == 0 ? "\(step / 60)m"
            : "\(step)s(DEV)"
        parts.append("checkIn=\(checkIn)")
        return "[Bouncer Gate] " + parts.joined(separator: " ")
    }

    // MARK: - The apps being gated

    /// What the user picked, as opaque tokens. Stored as JSON because that is
    /// the only representation that survives the trip between processes —
    /// `FamilyActivitySelection` is Codable precisely so this can be done.
    public static var selection: FamilyActivitySelection? {
        get {
            guard let data = defaults.data(forKey: Key.selection) else { return nil }
            return try? JSONDecoder().decode(FamilyActivitySelection.self, from: data)
        }
        set {
            guard let value = newValue, let data = try? JSONEncoder().encode(value) else {
                defaults.removeObject(forKey: Key.selection)
                return
            }
            defaults.set(data, forKey: Key.selection)
        }
    }

    /// Whether there is anything to gate. An empty selection with the gate
    /// armed is the state where the user thinks it is on and nothing happens,
    /// so the UI checks this before claiming to be protecting anything.
    /// Web domains are not part of this — the gate shields apps only, because
    /// shielding x.com would shield Bouncer's own feed. See
    /// `GateController.save(selection:)`.
    public static var hasSelection: Bool {
        guard let selection else { return false }
        return !selection.applicationTokens.isEmpty
            || !selection.categoryTokens.isEmpty
    }

    public static var store: ManagedSettingsStore {
        ManagedSettingsStore(named: .init(storeName))
    }

    /// Take the web shield down, whatever the gate is doing.
    ///
    /// This gate shields apps and never websites — shielding x.com
    /// would shield Bouncer's own feed, which is served from it. Written as its
    /// own operation, callable from any state, because the states that most
    /// need it are the ones that skip `applyShield`: disarmed, no selection, or
    /// an engage window open. A shield settings store outlives the build that
    /// wrote it, so "we stopped setting this" is not the same as "it is not
    /// set", and only a write clears it.
    public static func clearWebShield() {
        let store = self.store
        store.shield.webDomains = nil
        store.shield.webDomainCategories = nil
    }

    public static var activity: DeviceActivityName { .init(activityName) }

    /// A check-in's event name. The minute mark is encoded in the name
    /// because that is the only channel the monitor gets back.
    public static func checkInEvent(second: Int) -> DeviceActivityEvent.Name {
        .init("gate.checkIn.\(second)")
    }

    /// How many check-ins one window may carry.
    ///
    /// Device Activity refuses an activity with too many events, and a refusal
    /// is not survivable here: `startMonitoring` throwing means the window has
    /// no way to close itself, so the shield action declines to open one at all
    /// and the primary button reads as broken. At the real settings — 15 minutes
    /// stepped by 2 — the ladder is seven rungs and the cap never binds. At the
    /// DEBUG-only 10-second step it binds immediately, which is the point:
    /// better a dev build that check-ins for the first few minutes than one that
    /// silently cannot open a window.
    public static let maxCheckIns = 20

    /// The second marks a check-in should land on inside one window: every
    /// `checkInStepSeconds` up to but not including the end of the window. The
    /// one that would coincide with the window ending is dropped — being asked
    /// whether you would like to stop, one second before being stopped, is
    /// noise.
    public static func checkInSeconds(inWindowOf windowSeconds: Int) -> [Int] {
        let step = checkInStepSeconds
        guard step > 0, windowSeconds > step else { return [] }
        return Array(stride(from: step, to: windowSeconds, by: step).prefix(maxCheckIns))
    }
}
#endif
