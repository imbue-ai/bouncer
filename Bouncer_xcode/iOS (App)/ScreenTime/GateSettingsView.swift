//
//  GateSettingsView.swift
//  iOS (App)
//
//  Where the gate is set up, after onboarding.
//
//  The configuration itself is GateSetupSections, shared verbatim with the last
//  slide of onboarding. What this screen adds around it is what only makes
//  sense once the feature exists: an explainer, and the switch that turns it
//  off. It is also the ONLY way back in — nothing asks for these permissions on
//  its own any more, so somebody who skipped the slide arrives here or nowhere.
//
//  The explainer does more work than usual, because this feature asks for an
//  unusual amount of trust — the same entitlement that puts a door in front of
//  X could put one in front of anything — and because the one thing it cannot
//  do is the thing people will assume it does. It cannot see inside an app.
//  Choosing "View in X" is a promise the user makes to themselves; it is not a
//  filter we enforce. Saying so plainly, on the screen where they decide, is
//  better than letting them discover it and conclude the feature is broken.
//

import SwiftUI
import FamilyControls

struct GateSettingsView: View {

    @StateObject private var gate = GateController.shared
    @State private var showingPicker = false

    var body: some View {
        List {
            explainer
            // The same sections as the last slide of onboarding — one
            // definition, two hosts. See GateSetupSections.
            GateSetupSections(gate: gate, showingPicker: $showingPicker)
            armSection
        }
        .listStyle(.insetGrouped)
        .scrollDismissesKeyboard(.interactively)
        .animation(.easeInOut(duration: 0.25), value: gate.authorization)
        .navigationTitle("Focused viewing")
        .familyActivityPicker(isPresented: $showingPicker, selection: Binding(
            get: { gate.selection },
            set: { gate.save(selection: $0) }
        ))
        .task {
            gate.reconcile()
            gate.logState("settings")
        }
        .onReceive(NotificationCenter.default.publisher(
            for: UIApplication.didBecomeActiveNotification)) { _ in
            gate.reconcile()
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
