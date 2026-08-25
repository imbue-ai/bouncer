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
            // The same sections as the last slide of onboarding — one
            // definition, two hosts. See GateSetupSections.
            GateSetupSections(gate: gate,
                              gatedHeader: "Focused social platforms",
                              showingPicker: $showingPicker)
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

    /// Present only when there is something to switch.
    ///
    /// It used to narrate the states in between — waiting on Screen Time,
    /// waiting on an app — under a heading of its own. Both are already
    /// legible from the sections above, where the permission row says it has
    /// not been granted and the app list says it is empty; saying it a second
    /// time in a section that otherwise holds a switch just makes an empty
    /// panel to scroll past.
    @ViewBuilder
    private var armSection: some View {
        if gate.authorization == .approved, gate.hasSelection {
            Section {
                // A toggle, not a "Turn on" button: by the time the permission
                // and the app list are done the decision has been made twice,
                // and the gate has already armed itself. This is how it gets
                // turned OFF — which has to stay one tap, or the whole thing
                // reads as a trap rather than a door.
                Toggle("Toggle Focused Viewing", isOn: Binding(
                    get: { gate.isArmed },
                    set: { $0 ? gate.arm() : gate.disarm() }
                ))

                if gate.isSessionOpen {
                    Label("X is open to you right now", systemImage: "door.left.hand.open")
                        .foregroundStyle(.orange)
                    Button("Close it now") { gate.closeSession() }
                }
            }
        }
    }
}
