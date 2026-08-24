//
//  GateController.swift
//  iOS (App)
//
//  The app's half of the gate: authorization, what to shield, arming and
//  disarming, and putting things right when the pieces disagree.
//
//  The extensions do the work while the app is not running — that is the whole
//  reason they exist — so this type is deliberately not the source of truth
//  about anything. It writes intentions into the App Group and reads back
//  whatever actually happened. The one thing it owns outright is
//  reconciliation: an extension that was never launched, or was killed
//  mid-flight, leaves the gate in a state only a running app can notice.
//

import Foundation
internal import Combine
import FamilyControls
import ManagedSettings
import DeviceActivity

@MainActor
final class GateController: ObservableObject {

    static let shared = GateController()

    /// Mirrors of the shared state, for SwiftUI. Written back through `Gate`
    /// so the extensions see them.
    @Published private(set) var authorization: AuthorizationStatus = .notDetermined
    @Published private(set) var isArmed: Bool = Gate.isArmed
    @Published private(set) var isSessionOpen: Bool = Gate.isSessionOpen
    @Published var selection = FamilyActivitySelection()
    @Published private(set) var lastError: String?

    /// What the shield calls the user, or nil. Written straight through to the
    /// App Group — the shield extension reads it fresh on every render, so a
    /// change here shows up on the next shield without a rebuild.
    @Published var displayName: String? = Gate.displayName {
        didSet { Gate.displayName = displayName }
    }

    /// The check-in ladder's step, in seconds.
    ///
    /// Seconds rather than minutes because the DEBUG-only 10-second option is
    /// not expressible in the other unit. `Gate` sorts out which of the two
    /// stored settings a given value belongs in.
    @Published var checkInStepSeconds: Int = Gate.checkInStepSeconds {
        didSet { Gate.setCheckInStepSeconds(checkInStepSeconds) }
    }

    private let center = AuthorizationCenter.shared

    private init() {
        authorization = center.authorizationStatus
        selection = Gate.selection ?? FamilyActivitySelection()
    }

    /// Web domains deliberately do not count — see `save(selection:)`. A
    /// selection of nothing but websites is an empty selection to this gate.
    var hasSelection: Bool {
        !selection.applicationTokens.isEmpty
            || !selection.categoryTokens.isEmpty
    }

    /// Offered at most once per launch. Cancelling the picker leaves the gate
    /// unset, and asking again on the next tap of the same button is nagging.
    private var offeredThisLaunch = false

    /// Also at most once per launch. `UNUserNotificationCenter` only ever shows
    /// its prompt once per install anyway, so this is about not re-entering the
    /// flow rather than about not nagging.
    private var askedNotificationsThisLaunch = false

    /// Whether it is worth asking. Nothing to offer once it is set up, and
    /// nothing to offer if they have said no by hand.
    var needsSetup: Bool {
        !Gate.userTurnedOff && !(authorization == .approved && hasSelection)
    }

    /// Ask for Screen Time access at the moment someone opens a feed, which is
    /// the only moment the question makes sense.
    ///
    /// It used to live behind a button in settings, which is a fine place for a
    /// setting and a terrible place for a permission: nobody goes looking for a
    /// prompt they have not been given a reason to want. Choosing to open
    /// X *is* the reason.
    ///
    /// Returns true when access is granted and the caller should go on to the
    /// app picker — the second half of setup, and the half only Apple's own UI
    /// can perform.
    func offerSetup() async -> Bool {
        guard needsSetup, !offeredThisLaunch else { return false }
        offeredThisLaunch = true
        if authorization != .approved {
            await requestAuthorization()
        }
        return authorization == .approved && !hasSelection
    }

    /// Ask for notifications, on the same tap that asks for Screen Time.
    ///
    /// Not a nicety and not really a separate feature: the shield's "View in Bouncer"
    /// button posts a notification and does nothing else, because an app
    /// extension has no way to open an app. Without permission that button is
    /// dead, and dead in the particular way that looks like our bug rather than
    /// a missing permission — the shield dismisses, nothing arrives, and there
    /// is nowhere for the user to find out why.
    ///
    /// Asked separately from `offerSetup` rather than inside it because the two
    /// have different lifetimes: someone who granted Screen Time months ago and
    /// has been declining notifications ever since still needs this one, and
    /// `offerSetup` returns early for them.
    @discardableResult
    func offerNotifications() async -> Bool {
        guard !askedNotificationsThisLaunch else { return true }
        askedNotificationsThisLaunch = true
        if await GateNotifications.isAuthorized() { return true }
        return await GateNotifications.requestAuthorization()
    }

    // MARK: - Authorization

    /// Ask for Screen Time access, for this person on this device.
    ///
    /// `.individual` rather than `.child`: the second enrols the device into
    /// someone else's Family Sharing supervision, which is a different product.
    /// This is a person choosing to put a door in front of themselves, and the
    /// API supports exactly that — with the same power, which is worth
    /// remembering when writing anything that touches `ManagedSettingsStore`.
    func requestAuthorization() async {
        do {
            try await center.requestAuthorization(for: .individual)
            authorization = center.authorizationStatus
            lastError = nil
            // Granting permission when apps are already chosen — a reinstall,
            // or a permission revoked and given back — completes the set.
            armIfReady()
        } catch {
            authorization = center.authorizationStatus
            // The failure people actually hit is a missing entitlement, and the
            // system's message for it is not obvious. Say both.
            lastError = "Screen Time access was not granted (\(error.localizedDescription)). "
                + "If this keeps happening, the app needs Apple's Family Controls entitlement."
        }
    }

    // MARK: - What is gated

    /// Web domains are dropped on the way in, and this is load-bearing rather
    /// than tidy-minded.
    ///
    /// Bouncer's X surface IS x.com, in a WKWebView. Screen
    /// Time's web shield is a system-level content filter, so shielding that
    /// domain shields it everywhere — including inside this app, which is the
    /// place the shield is supposed to be sending people. The gate would block
    /// its own destination, and "View in Bouncer" would hand the user a shield
    /// instead of the timeline.
    ///
    /// The app shield and the web shield are separate settings, so keeping one
    /// costs nothing of the other: tapping the X app still hits the
    /// door. What it does mean is that x.com in Safari stays open, and
    /// that is a real hole — but it is the hole that has to exist for the
    /// feature to work at all.
    func save(selection newValue: FamilyActivitySelection) {
        var newValue = newValue
        newValue.webDomainTokens = []

        selection = newValue
        Gate.selection = newValue
        // Changing the selection while armed has to re-apply, or the gate goes
        // on protecting yesterday's list.
        if isArmed { applyShield() }
        // And picking apps for the first time IS the decision — see armIfReady.
        armIfReady()
    }

    /// Turn the gate on the moment it has everything it needs, and not before.
    ///
    /// Permission and a list of apps are the only two things Apple will not let
    /// us default: the first is a system prompt, and the second is a picker
    /// whose tokens cannot be constructed in code. Everything after them is
    /// ours, and asking for one more tap to confirm what somebody has just
    /// spent two screens saying is how a feature ends up switched off in the
    /// only sense that matters.
    ///
    /// Not if they have turned it off by hand. That is a decision, and it
    /// outranks this one until they take it back.
    func armIfReady() {
        guard !Gate.userTurnedOff,
              authorization == .approved,
              hasSelection,
              !isArmed
        else { return }
        arm()
    }

    // MARK: - Arming

    func arm() {
        guard authorization == .approved, hasSelection else { return }
        Gate.userTurnedOff = false
        Gate.isArmed = true
        isArmed = true
        closeSession()
        applyShield()
    }

    func disarm() {
        Gate.userTurnedOff = true
        Gate.isArmed = false
        isArmed = false
        Gate.sessionOpenedAt = nil
        isSessionOpen = false
        Gate.store.clearAllSettings()
        DeviceActivityCenter().stopMonitoring([Gate.activity])
        GateNotifications.clearAll()
    }

    /// Put the shield up. Categories as well as apps: picking "Social" is a
    /// legitimate way to answer the picker and shielding only the individually
    /// chosen apps would silently ignore half of what they said.
    private func applyShield() {
        let store = Gate.store
        store.shield.applications = selection.applicationTokens.isEmpty
            ? nil
            : selection.applicationTokens
        store.shield.applicationCategories = selection.categoryTokens.isEmpty
            ? nil
            : .specific(selection.categoryTokens)
        // Never. See `save(selection:)` — shielding x.com would shield
        // Bouncer's own feed.
        Gate.clearWebShield()
    }

    // MARK: - The open session

    /// Put the door back. Safe to call when it is already up, which is most of
    /// the times it is called.
    ///
    /// Silent now. There is no window to have expired and nothing was taken
    /// away — the shield being up is the gate's resting state, not an event.
    func closeSession() {
        Gate.sessionOpenedAt = nil
        isSessionOpen = false
        DeviceActivityCenter().stopMonitoring([Gate.activity])
        if Gate.isArmed { applyShield() }
    }

    /// Print what the gate thinks is true. Called at launch and whenever the
    /// settings screen appears — the two moments someone is in a position to
    /// wonder why nothing is happening.
    func logState(_ context: String) {
        let status: String
        switch center.authorizationStatus {
        case .approved: status = "approved"
        case .approvedWithDataAccess: status = "approved (with data access)"
        case .denied: status = "DENIED"
        case .notDetermined: status = "NOT ASKED"
        @unknown default: status = "unknown"
        }
        print("\(Gate.report(authorization: status)) \(pluginReport()) at=\(context)")
    }

    /// What is actually installed alongside us, and when it was built.
    ///
    /// `shieldDrawn=NEVER` has two very different causes and no way to tell
    /// them apart from inside the app: an extension that iOS never launched,
    /// and an extension that is not on the device at all. This reads the
    /// installed bundle rather than the build we think we made, so it also
    /// catches the case where the phone is running an older copy — the reason
    /// we have gone round this loop twice already.
    private func pluginReport() -> String {
        guard let plugins = Bundle.main.builtInPlugInsURL,
              let names = try? FileManager.default.contentsOfDirectory(atPath: plugins.path) else {
            return "plugins=NONE"
        }
        let appexes = names.filter { $0.hasSuffix(".appex") }
        let stamp = appexes.compactMap { name -> Date? in
            let exec = plugins.appendingPathComponent(name)
                .appendingPathComponent(name.replacingOccurrences(of: ".appex", with: ""))
            return (try? FileManager.default.attributesOfItem(atPath: exec.path))?[.modificationDate] as? Date
        }.max()

        let built: String
        if let stamp {
            let mins = Int(Date().timeIntervalSince(stamp) / 60)
            built = " builtMinsAgo=\(mins)"
        } else {
            built = " builtMinsAgo=?"
        }
        return "plugins=\(appexes.count)[\(appexes.map { $0.replacingOccurrences(of: ".appex", with: "") }.joined(separator: ","))]\(built)"
    }

    /// Called when the app comes to the front.
    ///
    /// The engage window is closed by a Device Activity event, in an extension
    /// that iOS launches on its own schedule and can decline to launch at all —
    /// under memory pressure, or if monitoring never started because the
    /// extension that asked for it was killed first. When that happens the
    /// shield stays down indefinitely and the gate has quietly stopped
    /// existing, which is the worst failure available to it: it looks like it
    /// is working.
    ///
    /// So the app checks the wall clock whenever it is in a position to. This
    /// is a backstop, not the mechanism — it only runs when Bouncer is opened,
    /// which is exactly when someone has chosen to be here anyway.
    func reconcile() {
        authorization = center.authorizationStatus
        isArmed = Gate.isArmed
        isSessionOpen = Gate.isSessionOpen

        // First, and unconditionally. Every other repair below is guarded on
        // the gate being armed and set up, and a web shield left over from an
        // older build is exactly as blocking when the gate is off as when it is
        // on — it is the app's own feed that stops loading either way. Nothing
        // in the current code sets one, so this is pure cleanup, and it costs
        // two writes on foreground.
        Gate.clearWebShield()

        // On by default, and stays on. A reinstall, a restore, or iOS clearing
        // the store leaves the intention recorded and the shield gone, which
        // looks exactly like a working gate that has stopped working.
        armIfReady()
        // Unconditional rather than only-when-the-shield-looks-empty. It is
        // idempotent, it costs three writes, and the case it now catches is the
        // one that was invisible before: a store still carrying a web-domain
        // shield from a build that set one. That shield blocks x.com
        // inside Bouncer, so "the pieces disagree" includes "the shield is
        // there, and it is shielding the wrong thing".
        if isArmed, !isSessionOpen, hasSelection {
            applyShield()
        }

        // Log on every foreground, not just at launch.
        //
        // The launch line is printed once, before anything interesting has
        // happened, and by the time you have gone to X, met the shield
        // and come back, it is thousands of lines up a console that has been
        // filling with feed evaluations the whole time. This one lands at the
        // bottom, immediately after the trip it is describing — which is the
        // only moment `shieldDrawn` is worth reading.
        logState("foreground")

        guard Gate.isArmed, Gate.sessionOpenedAt != nil else { return }

        // Being here at all closes it.
        //
        // Bouncer is in the foreground, so the user is demonstrably not in
        // X, which makes this the one moment re-applying the shield
        // cannot interrupt anybody. It is also what makes "the shield is there
        // every time you open X" true in practice: the session that
        // "View in X" opened lasts until they next come back here.
        closeSession()
    }
}
