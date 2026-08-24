//
//  Gate.swift
//  Shared by the app and all three Screen Time extensions.
//
//  The names, keys and stored state that the four processes have to agree
//  about. They cannot see each other's memory — an app extension is its own
//  process, launched on demand and killed again — so everything they share
//  passes through the App Group container defined here.
//
//  WHAT THE GATE IS
//
//  X (or whatever the user picks) is shielded. Tapping it gets the system's
//  shield screen, which is ours to configure: a title, and two buttons.
//
//      MESSAGES & REPLIES   the shield lifts for a few minutes of USE, and
//                           they are in the real app with everything that
//                           implies. This is the path most screen-time tools
//                           refuse to build, and refusing is why people turn
//                           them off: a friend's message is not scrolling, and
//                           an app that cannot tell the difference gets deleted
//                           the first time it stands between you and one.
//
//      WATCH INTENTIONALLY  a notification arrives, and tapping it opens
//                           Bouncer on the feed. The hop through a notification
//                           is not a design choice — an app extension cannot
//                           launch an app, and this is the only bridge iOS
//                           gives us.
//
//  During the engage window, check-ins arrive as notifications rather than as
//  a shield thrown over the app mid-sentence: "still here — switch to your
//  viewing?" A notification can be ignored, which is the point. The window is
//  measured in minutes of USE, not wall-clock, so putting the phone down does
//  not spend it.
//
//  WHAT SCREEN TIME CANNOT DO, WHICH SHAPES ALL OF THE ABOVE
//
//  It cannot see inside an app. There is no "they are in DMs" signal, and no
//  way to allow messages while blocking the feed. The fork is therefore a
//  question asked at the door and answered on trust, with a time box behind it
//  rather than an enforcement mechanism. Every honest version of this feature
//  has that shape.
//
//  It also cannot tell us WHICH app was tapped: the tokens are opaque, with no
//  bundle id and no name. The shield knows it is shielding something, and can
//  render Apple's label for it, and that is all.
//

import Foundation

// Deliberately Foundation-only.
//
// Everything here is keys and numbers in the App Group, and it is compiled into
// the shield configuration extension — a process iOS gives a very small memory
// budget and kills without ceremony. FamilyControls, ManagedSettings and
// DeviceActivity live next door in GateTokens.swift, which that extension does
// not compile, so answering "what should this shield say" never loads a
// framework it has no use for.

public enum Gate {

    // MARK: - Identity

    /// The App Group every process here reads and writes through. Must match
    /// the `com.apple.security.application-groups` entitlement on the app and
    /// on all three extensions, or they silently get separate containers and
    /// nothing works while everything appears to.
    public static let appGroupID = "group.com.imbue.xbouncer"

    /// Where the shield settings live. Named rather than default so that
    /// clearing ours never disturbs another store on the device.
    public static let storeName = "bouncerGate"

    /// The monitoring session that runs while the engage window is open.
    public static let activityName = "bouncerEngageWindow"

    /// Notification identifiers, and the key its payload routes on.
    public enum Notify {
        public static let category = "bouncer.gate"
        public static let routeKey = "bouncer.route"
        public static let checkInID = "bouncer.gate.checkin"
        public static let handoffID = "bouncer.gate.handoff"
        /// Value of `routeKey`: which platform to open on launch.
        public static let routeTwitter = "twitter"
    }

    public static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroupID) ?? .standard
    }

    // MARK: - Stored state

    /// Internal rather than private: `GateTokens.swift` is the other half of
    /// this type and reads `selection` out of the same container. Still not
    /// public — no other module has business naming these strings.
    enum Key {
        static let armed = "gate.armed"
        static let selection = "gate.selection"
        static let checkInMinutes = "gate.checkInMinutes"
        static let sessionOpenedAt = "gate.sessionOpenedAt"
        static let lastHandoffAt = "gate.lastHandoffAt"
        static let userTurnedOff = "gate.userTurnedOff"
        static let devCheckInSeconds = "gate.devCheckInSeconds"
        static let displayName = "gate.displayName"
        static let shieldTint = "gate.shieldTint"
        static let lastShieldRenderAt = "gate.lastShieldRenderAt"
        static let lastShieldActionAt = "gate.lastShieldActionAt"
    }

    /// When our shield configuration extension was last asked what the shield
    /// should look like, and when the action extension last handled a button.
    ///
    /// Both exist to answer one question that is otherwise unanswerable from
    /// the app: is our code running at all? A shield that looks like Apple's
    /// has two very different causes — an extension that never launched, and an
    /// extension that launched and drew the wrong thing — and no way to tell
    /// them apart by looking. These make it a fact instead of a guess: see the
    /// shield, open Bouncer, read the launch line.
    public static var lastShieldRenderAt: Date? {
        get { defaults.object(forKey: Key.lastShieldRenderAt) as? Date }
        set { defaults.set(newValue, forKey: Key.lastShieldRenderAt) }
    }

    public static var lastShieldActionAt: Date? {
        get { defaults.object(forKey: Key.lastShieldActionAt) as? Date }
        set { defaults.set(newValue, forKey: Key.lastShieldActionAt) }
    }

    /// Stamp the two above and force them to disk before we are killed.
    ///
    /// `synchronize()` is deprecated on the grounds that it is unnecessary —
    /// true for a process that gets to keep running. A shield extension does
    /// not: iOS launches it, takes one configuration off it, and tears the
    /// process down, and a write still sitting in memory goes with it. Without
    /// this the stamp is unreliable in exactly the case it exists to report on,
    /// which makes a missing stamp unreadable — it could mean the extension
    /// never ran, or that it ran and the note was lost on the way out.
    public static func stampShieldRender() {
        lastShieldRenderAt = Date()
        defaults.synchronize()
    }

    public static func stampShieldAction() {
        lastShieldActionAt = Date()
        defaults.synchronize()
    }

    /// Whether the user has turned the gate on. Separate from "is a shield
    /// currently applied", which is a fact about the moment rather than an
    /// intention — during an engage window the gate is armed and the shield is
    /// down, and both of those are correct.
    public static var isArmed: Bool {
        get { defaults.bool(forKey: Key.armed) }
        set { defaults.set(newValue, forKey: Key.armed) }
    }

    /// How often, in minutes of use, to ask whether they would rather be
    /// viewing in Bouncer instead. Zero turns check-ins off.
    public static var checkInMinutes: Int {
        get { defaults.object(forKey: Key.checkInMinutes) as? Int ?? 5 }
        set { defaults.set(max(0, newValue), forKey: Key.checkInMinutes) }
    }

    /// What to call the person on the shield, or nil to stay impersonal.
    ///
    /// Lives here, in the Foundation-only half, precisely so the shield
    /// configuration extension can read it — that target compiles this file and
    /// nothing else of the gate. Anything the shield needs to say has to be
    /// expressible as plain stored values for the same reason: the extension
    /// cannot call into the app, ask the network, or load a token.
    public static var displayName: String? {
        get { defaults.string(forKey: Key.displayName) }
        set {
            let trimmed = newValue?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let trimmed, !trimmed.isEmpty {
                defaults.set(trimmed, forKey: Key.displayName)
            } else {
                defaults.removeObject(forKey: Key.displayName)
            }
        }
    }

    // MARK: - How the shield looks

    /// The shield's colours, chosen by the user during onboarding.
    ///
    /// A PAIR, not a colour. The shield is a light title and a light button
    /// fill on a dark ground, with the dark colour used again for the type
    /// inside that button — so a single free-choice colour has two ways to go
    /// wrong at once: pick something dark and the title vanishes into the
    /// background, pick something light for the ground and the button's own
    /// label does. Shipping coordinated pairs is what makes every choice on the
    /// picker a legible shield, which a system colour well cannot promise.
    ///
    /// Raw components rather than a colour type because this file is compiled
    /// into the shield configuration extension, which is Foundation-only on
    /// purpose (see the note at the top). Each consumer builds its own
    /// UIColor / SwiftUI Color from these.
    public enum ShieldTint: String, CaseIterable, Sendable {
        /// The original, sampled from the app icon: #E09898 on #482020.
        case blush
        case slate
        case moss
        case sand
        case mono

        public var displayName: String {
            switch self {
            case .blush: return "Blush"
            case .slate: return "Slate"
            case .moss: return "Moss"
            case .sand: return "Sand"
            case .mono: return "Mono"
            }
        }

        /// The light half: the title, the icon, and the primary button's fill.
        public var accent: (red: Double, green: Double, blue: Double) {
            switch self {
            case .blush: return (0.878, 0.596, 0.596)
            case .slate: return (0.639, 0.741, 0.851)
            case .moss:  return (0.659, 0.769, 0.627)
            case .sand:  return (0.910, 0.816, 0.631)
            case .mono:  return (0.906, 0.886, 0.871)
            }
        }

        /// The dark half: the ground, and the type on the primary button.
        public var ink: (red: Double, green: Double, blue: Double) {
            switch self {
            case .blush: return (0.282, 0.125, 0.125)
            case .slate: return (0.106, 0.157, 0.212)
            case .moss:  return (0.122, 0.180, 0.114)
            case .sand:  return (0.227, 0.180, 0.098)
            case .mono:  return (0.133, 0.122, 0.118)
            }
        }
    }

    /// Which pair the shield draws itself in.
    ///
    /// Read fresh on every render, like `displayName` — the extension is
    /// relaunched for each shield, so a change here shows up on the very next
    /// one with no rebuild. An unrecognised stored value falls back to the
    /// original rather than to nothing: a shield is not the place to discover
    /// that a setting was written by a newer build.
    public static var shieldTint: ShieldTint {
        get { ShieldTint(rawValue: defaults.string(forKey: Key.shieldTint) ?? "") ?? .blush }
        set { defaults.set(newValue.rawValue, forKey: Key.shieldTint) }
    }

    /// DEV ONLY. A sub-minute check-in step, in seconds, overriding
    /// `checkInMinutes` while it is non-zero.
    ///
    /// It exists because the shortest interval the real UI can express is two
    /// minutes, and two minutes of *use* is a long time to sit in X
    /// waiting to find out whether a notification fires. Only DEBUG builds can
    /// set it — see the picker in GateSettingsView — but the plumbing is
    /// unconditional so the extensions, which are compiled separately, do not
    /// need to agree about DEBUG to read the same number.
    public static var devCheckInSeconds: Int {
        get { defaults.integer(forKey: Key.devCheckInSeconds) }
        set { defaults.set(max(0, newValue), forKey: Key.devCheckInSeconds) }
    }

    /// The check-in step actually used, in seconds. Zero means no check-ins.
    ///
    /// Seconds rather than minutes because this is the unit the ladder is built
    /// in, and the dev override is not expressible in the other one.
    public static var checkInStepSeconds: Int {
        devCheckInSeconds > 0 ? devCheckInSeconds : checkInMinutes * 60
    }

    /// Write the step back. Whole minutes are a real setting and clear the dev
    /// override; anything else can only be the override, because nothing
    /// outside a DEBUG build can produce it.
    public static func setCheckInStepSeconds(_ seconds: Int) {
        if seconds <= 0 {
            devCheckInSeconds = 0
            checkInMinutes = 0
        } else if seconds % 60 == 0 {
            devCheckInSeconds = 0
            checkInMinutes = seconds / 60
        } else {
            devCheckInSeconds = seconds
        }
    }

    /// When the current engage window was opened, or nil when the shield is up.
    /// Written by the shield action, cleared when the window closes.
    public static var sessionOpenedAt: Date? {
        get { defaults.object(forKey: Key.sessionOpenedAt) as? Date }
        set { defaults.set(newValue, forKey: Key.sessionOpenedAt) }
    }

    /// Set only when the user turns the gate off by hand.
    ///
    /// The gate arms itself as soon as it has permission and a list of apps —
    /// there is no third step, because a feature that needs one more tap after
    /// being set up is a feature half the people who wanted it never switch on.
    /// But "on by default" and "on against your wishes" are different things,
    /// and this is what keeps them apart: once someone has said no, picking a
    /// different app later must not quietly say yes for them.
    public static var userTurnedOff: Bool {
        get { defaults.bool(forKey: Key.userTurnedOff) }
        set { defaults.set(newValue, forKey: Key.userTurnedOff) }
    }

    /// When we last sent them to Bouncer, so the app can tell an intentional
    /// launch from an ordinary one.
    public static var lastHandoffAt: Date? {
        get { defaults.object(forKey: Key.lastHandoffAt) as? Date }
        set { defaults.set(newValue, forKey: Key.lastHandoffAt) }
    }

    public static var isSessionOpen: Bool { sessionOpenedAt != nil }

    // MARK: - Diagnostics

    /// Whether the App Group actually resolved.
    ///
    /// `UserDefaults(suiteName:)` returns nil when the group is not in the
    /// entitlement or not provisioned, and `defaults` then quietly falls back
    /// to `.standard` — at which point the app and its extensions are writing
    /// to different containers while every read succeeds. Nothing crashes,
    /// nothing logs, and the gate simply never does anything. Worth being able
    /// to ask directly.
    public static var appGroupResolved: Bool {
        UserDefaults(suiteName: appGroupID) != nil
    }
}
