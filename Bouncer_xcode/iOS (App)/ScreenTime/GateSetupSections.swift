//
//  GateSetupSections.swift
//  iOS (App)
//
//  Setting the gate up: the two permissions, the apps, how often to check in,
//  and what the shield looks like. One definition, shown in two places.
//
//  It has to be two places, and it has to be one definition.
//
//  TWO PLACES, because nothing asks for these permissions on its own any more.
//  The gate used to ask on the first tap into a feed, which meant somebody who
//  had already declined during onboarding was asked again by their next
//  action — the same question with the answer already given. So the ask now
//  happens only where the user chose to be: the last slide of onboarding, and
//  Settings → Focused viewing. Skipping the slide has to leave a way back in,
//  or declining once is declining forever.
//
//  ONE DEFINITION, because the alternative was tried for about a day and drifts
//  immediately. These two screens were separate copies of the same four
//  sections, and by the time the copy on the slide had been reworded three
//  times, the copy in settings was describing a different product.
//
//  What differs between the hosts belongs to the hosts: onboarding puts a title
//  above these, settings puts an explainer above and the on/off toggle below.
//

import FamilyControls
import SwiftUI

struct GateSetupSections: View {

    @ObservedObject var gate: GateController

    /// Raised when the user asks for Apple's app picker. Owned by the host
    /// because `.familyActivityPicker` has to be attached to the enclosing
    /// List, not to a section inside it.
    @Binding var showingPicker: Bool

    @FocusState private var nameFocused: Bool
    @State private var notifications: NotificationPermission = .unknown
    @State private var tint: Gate.ShieldTint = Gate.shieldTint
    @State private var name: String = Gate.displayName ?? ""

    // NOTHING MAY BE ATTACHED TO THE `Group` BELOW.
    //
    // A modifier on a Group is applied to each of its children separately, not
    // once around the set — so a `.toolbar` here became one toolbar per
    // section, and the keyboard grew a row of four identical Done buttons. The
    // same mistake made `.task` and `.onReceive` fire once per section too.
    //
    // Modifiers therefore go on exactly one thing: the single section that
    // needs them, or the view that owns them. `.animation` for the sections
    // appearing belongs to the enclosing List, so the hosts apply that.
    var body: some View {
        Group {
            permissionsSection
            // Neither of these can do anything before Screen Time is granted —
            // the picker cannot be raised and there is nothing to count usage
            // against — so they arrive when they become answerable.
            if gate.authorization == .approved {
                gatedSection
                timingSection
            }
            customizeSection
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private var permissionsSection: some View {
        Section {
            permissionRow(
                title: "Screen Time",
                why: "Allows Bouncer to gate other apps.",
                state: screenTimeState,
                ask: { Task { await gate.requestAuthorization() } }
            )

            permissionRow(
                title: "Notifications",
                why: "Allows Bouncer to remind you to scroll intentionally.",
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
        } header: {
            Text("Permissions")
        }
        .task { notifications = await NotificationPermission.current() }
        // A refusal is repaired in Settings, which means leaving the app and
        // coming back. Re-reading on return is what makes "Fix in Settings" a
        // repair rather than a suggestion.
        .onReceive(NotificationCenter.default.publisher(
            for: UIApplication.didBecomeActiveNotification)) { _ in
            Task { notifications = await NotificationPermission.current() }
        }
    }

    private var gatedSection: some View {
        Section {
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

            if gate.hasSelection {
                // Apple's own labels. A token's name cannot be read — that is
                // the whole point of the design — but the system will draw it.
                ForEach(Array(gate.selection.applicationTokens), id: \.self) { token in
                    Label(token)
                        .labelStyle(.titleAndIcon)
                }
            }
        } header: {
            Text("What's gated")
        } footer: {
            // The gate arms itself the moment it has both halves — see
            // GateController.armIfReady — so this is the last decision, not a
            // step before one.
            Text(gate.hasSelection
                 ? "Bouncer's gate is active."
                 : "Select your social platforms.")
        }
    }

    private var timingSection: some View {
        Section {
            // Tagged in seconds — see GateController.checkInStepSeconds. The
            // real options are all whole minutes; only the DEBUG ones are not.
            Picker("Check in every", selection: Binding(
                get: { gate.checkInStepSeconds },
                set: { gate.checkInStepSeconds = $0 }
            )) {
                Text("Never").tag(0)
#if DEBUG
                Text("10 sec (dev)").tag(10)
                Text("30 sec (dev)").tag(30)
#endif
                ForEach([2, 5, 10, 15], id: \.self) { Text("\($0) min").tag($0 * 60) }
            }
        } header: {
            Text("Check-ins")
        } footer: {
#if DEBUG
            Text("Dev builds can check in every 10 or 30 seconds. iOS samples "
                 + "usage about once a minute, so those fire approximately and "
                 + "late — enough to see the mechanism work, not a stopwatch. "
                 + "Only the first \(Gate.maxCheckIns) fit in one window.")
                .foregroundStyle(.orange)
#endif
        }
    }

    private var customizeSection: some View {
        Section {
            // Optional, and empty by default. A door that knows your name is
            // friendlier than one that does not, and the shield is a moment
            // where friendliness does real work — but being greeted by name is
            // a nicety some people find grating, so blank is the right default.
            TextField("Your name (optional)", text: $name)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .focused($nameFocused)
                .submitLabel(.done)
                // Persisted when editing ENDS, not on every keystroke.
                //
                // `gate.displayName` is @Published on a singleton this whole
                // view observes, so writing it per character re-rendered every
                // section — the token list, the swatches, the preview — between
                // one letter and the next. The typing stuttered and the cursor
                // could jump. Nothing needs the stored value mid-word: the
                // preview greeting reads the local `name`, so it still updates
                // live, and the extensions only read the App Group when they
                // draw a shield.
                .onSubmit { commitName() }
                .onChange(of: nameFocused) { _, focused in
                    if !focused { commitName() }
                }
                .onDisappear { commitName() }
                // On the field itself, so there is exactly one of these.
                // Onboarding has no navigation bar and its Next button sits
                // under the keyboard, so without an accessory there is no
                // obvious way to put the keyboard away again.
                .toolbar {
                    ToolbarItemGroup(placement: .keyboard) {
                        Spacer()
                        Button("Done") { nameFocused = false }
                    }
                }

            ShieldTintPicker(selection: $tint, name: name)
                .onChange(of: tint) { _, newValue in Gate.shieldTint = newValue }
        } header: {
            Text("Customize")
        } footer: {
            Text("This is the screen you'll meet when you open a gated app.")
        }
    }

    /// Write the name through to the App Group, where the shield extension
    /// reads it. Idempotent — it is called from three places, because there
    /// are three ways to stop editing: Done, tapping elsewhere, and leaving.
    private func commitName() {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard gate.displayName != trimmed else { return }
        gate.displayName = trimmed
    }

    // MARK: - Bits

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
                    // iOS will not show a prompt twice; after a refusal this is
                    // the only control that does anything.
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

    private var selectionSummary: String {
        let apps = gate.selection.applicationTokens.count
        let categories = gate.selection.categoryTokens.count
        if apps == 0 && categories == 0 { return "None" }
        var parts: [String] = []
        if apps > 0 { parts.append("\(apps) app\(apps == 1 ? "" : "s")") }
        if categories > 0 { parts.append("\(categories) categor\(categories == 1 ? "y" : "ies")") }
        return parts.joined(separator: ", ")
    }
}
