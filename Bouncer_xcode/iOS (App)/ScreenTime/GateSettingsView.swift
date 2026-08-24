//
//  GateSettingsView.swift
//  iOS (App)
//
//  Where the gate is set up. Four decisions, in the order they have to be made:
//  grant access, choose what to gate, say how long a messages window lasts, and
//  turn it on.
//
//  The copy does more work than usual here, because this feature asks for an
//  unusual amount of trust — the same entitlement that puts a door in front of
//  X could put one in front of anything — and because the one thing it
//  cannot do is the thing people will assume it does. It cannot see inside an
//  app. "Messages" is a promise the user makes to themselves and we time-box;
//  it is not a filter we enforce. Saying so plainly, once, on the screen where
//  they decide, is better than letting them discover it and conclude the
//  feature is broken.
//

import SwiftUI
import FamilyControls

struct GateSettingsView: View {

    @StateObject private var gate = GateController.shared
    @State private var showingPicker = false
    @State private var notifications: NotificationPermission = .unknown

    var body: some View {
        List {
            explainer
            accessSection
            selectionSection
            nameSection
            timingSection
            armSection
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Focused viewing")
        .familyActivityPicker(isPresented: $showingPicker, selection: pickerBinding)
        .task {
            gate.reconcile()
            gate.logState("settings")
            notifications = await NotificationPermission.current()
        }
        // A permission is usually fixed in Settings, which means leaving and
        // coming back. Re-reading on return is what turns "Fix in Settings"
        // into a repair rather than a suggestion.
        .onReceive(NotificationCenter.default.publisher(
            for: UIApplication.didBecomeActiveNotification)) { _ in
            gate.reconcile()
            Task { notifications = await NotificationPermission.current() }
        }
    }

    /// The picker hands back a selection directly; persisting on change keeps
    /// the shield and the list in step without a save button to forget.
    private var pickerBinding: Binding<FamilyActivitySelection> {
        Binding(
            get: { gate.selection },
            set: { gate.save(selection: $0) }
        )
    }

    // MARK: - Sections

    /// Optional, and empty by default.
    ///
    /// A door that knows your name is friendlier than one that does not, and
    /// the shield is a moment where friendliness does real work — it is the
    /// screen standing between someone and a habit, and reading as a person
    /// rather than a system alert is most of whether it gets dismissed on
    /// reflex. Left blank it simply asks the question, which is the right
    /// default: being greeted by name is a nicety some people find grating.
    private var nameSection: some View {
        Section {
            TextField("Your name", text: Binding(
                get: { gate.displayName ?? "" },
                set: { gate.displayName = $0 }
            ))
            .textInputAutocapitalization(.words)
            .autocorrectionDisabled()
        } header: {
            Text("On the shield")
        } footer: {
            Text(gate.displayName.map { "The shield will open with \"Hi \($0),\" then ask what you're here for." }
                 ?? "Leave blank and the shield just asks what you're here for.")
        }
    }

    private var explainer: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                Text("A door, not a wall")
                    .font(.headline)
                Text("Opening a gated app asks where you'd like to view it. "
                     + "**View in X** opens the real app, so nobody waits "
                     + "on your screen-time settings. **View in Bouncer** opens "
                     + "the same timeline in your own viewer.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                Text("Nothing shuts the app on you. The door is simply back the "
                     + "next time you open it, and check-ins in between are "
                     + "notifications you can ignore.")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            }
            .padding(.vertical, 4)
        }
    }

    /// Both permissions, and a way out of either refusal.
    ///
    /// iOS will not show a permission prompt a second time, so once someone has
    /// tapped Don't Allow, every in-app button that claims to ask again is
    /// lying. The honest control at that point is a link into Settings, and it
    /// has to be offered here — where somebody who noticed the gate is not
    /// working will actually come looking — rather than only in the onboarding
    /// they have already been through.
    @ViewBuilder
    private var accessSection: some View {
        Section("Permissions") {
            permissionRow(
                title: "Screen Time",
                why: "Puts the door in front of X.",
                state: screenTimeState,
                ask: { Task { await gate.requestAuthorization() } }
            )

            permissionRow(
                title: "Notifications",
                why: "Check-ins while you're in X, and the tap that brings you back to Bouncer.",
                state: notifications.permissionState,
                ask: {
                    Task {
                        _ = await GateNotifications.requestAuthorization()
                        notifications = await NotificationPermission.current()
                    }
                }
            )

            if let error = gate.lastError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
    }

    @ViewBuilder
    private func permissionRow(title: String,
                               why: String,
                               state: PermissionState,
                               ask: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(title, systemImage: state == .granted ? "checkmark.circle.fill" : "circle.dashed")
                    .foregroundStyle(state == .granted ? .green : .secondary)
                Spacer()
                switch state {
                case .granted:
                    EmptyView()
                case .notAsked:
                    Button("Allow", action: ask).font(.subheadline.weight(.semibold))
                case .denied:
                    // The only thing that works after a refusal.
                    Button("Fix in Settings") { SystemSettings.open() }
                        .font(.subheadline.weight(.semibold))
                }
            }
            Text(why)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    private var screenTimeState: PermissionState {
        switch gate.authorization {
        case .approved: return .granted
        case .denied: return .denied
        default: return .notAsked
        }
    }

    private var selectionSection: some View {
        Section("What's gated") {
            Button {
                showingPicker = true
            } label: {
                HStack {
                    Label("Choose apps", systemImage: "square.grid.2x2")
                    Spacer()
                    Text(selectionSummary)
                        .foregroundStyle(.secondary)
                }
            }
            .disabled(gate.authorization != .approved)

            if gate.hasSelection {
                // Apple's own labels. We cannot read a token's name — the whole
                // point of the design — but we can ask the system to draw it.
                ForEach(Array(gate.selection.applicationTokens), id: \.self) { token in
                    Label(token)
                        .labelStyle(.titleAndIcon)
                }
            }
        }
    }

    private var selectionSummary: String {
        let apps = gate.selection.applicationTokens.count
        let categories = gate.selection.categoryTokens.count
        if apps == 0 && categories == 0 { return "None" }
        var parts: [String] = []
        if apps > 0 { parts.append("\(apps) app\(apps == 1 ? "" : "s")") }
        if categories > 0 { parts.append("\(categories) categor\(categories == 1 ? "y" : "ies")") }
        return parts.joined(separator: ", ")
    }

    private var timingSection: some View {
        Section {
            // Tagged in seconds — see GateController.checkInStepSeconds. The
            // real options are all whole minutes; only the DEBUG ones are not.
            Picker("Check in every", selection: $gate.checkInStepSeconds) {
                Text("Never").tag(0)
#if DEBUG
                Text("10 sec (dev)").tag(10)
                Text("30 sec (dev)").tag(30)
#endif
                ForEach([2, 5, 10, 15], id: \.self) { Text("\($0) min").tag($0 * 60) }
            }
        } header: {
            Text("Timing")
        } footer: {
            Text("Counted in minutes of use, not wall clock — the clock doesn't "
                 + "run while your phone is in your pocket. Check-ins arrive as "
                 + "notifications you can ignore; nothing closes X on you.")
#if DEBUG
            Text("Dev builds can check in every 10 or 30 seconds. iOS samples "
                 + "usage about once a minute, so those fire approximately and "
                 + "late — enough to see the mechanism work, not a stopwatch. "
                 + "Only the first \(Gate.maxCheckIns) fit in one window.")
                .foregroundStyle(.orange)
#endif
        }
    }

    @ViewBuilder
    private var armSection: some View {
        Section {
            if gate.authorization != .approved {
                Label("Waiting on Screen Time access", systemImage: "hourglass")
                    .foregroundStyle(.secondary)
            } else if !gate.hasSelection {
                Label("Waiting on an app to gate", systemImage: "square.dashed")
                    .foregroundStyle(.secondary)
            } else {
                // A toggle, not a "Turn on" button: by the time both of the
                // above are done the decision has been made twice, and the
                // gate has already armed itself. This is how it gets turned
                // OFF — which has to stay one tap, or the whole thing reads as
                // a trap rather than a door.
                Toggle("Gate is on", isOn: Binding(
                    get: { gate.isArmed },
                    set: { $0 ? gate.arm() : gate.disarm() }
                ))

                if gate.isSessionOpen {
                    Label("X is open to you right now", systemImage: "door.left.hand.open")
                        .foregroundStyle(.orange)
                    Button("Close it now") { gate.closeSession() }
                }
            }
        } footer: {
            if gate.authorization == .approved && !gate.hasSelection {
                Text("It switches on by itself as soon as you choose one.")
            } else if gate.isArmed {
                Text("Opening a gated app now asks what you're here for.")
            }
        }
    }
}
