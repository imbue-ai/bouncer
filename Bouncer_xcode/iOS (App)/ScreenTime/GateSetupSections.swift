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
import ManagedSettings
import SwiftUI
import WidgetKit

struct GateSetupSections: View {

    @ObservedObject var gate: GateController

    /// The heading over the app list. The two hosts word it differently —
    /// onboarding is instructing ("Select your Social Platforms"), settings is
    /// labelling something that already exists ("Focused social platforms") —
    /// and that is the whole of their disagreement, so it is a parameter rather
    /// than a reason to fork the view again.
    var gatedHeader: String

    /// Raised when the user asks for Apple's app picker. Owned by the host
    /// because `.familyActivityPicker` has to be attached to the enclosing
    /// List, not to a section inside it.
    @Binding var showingPicker: Bool

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
                state: screenTimeState,
                ask: { Task { await gate.requestAuthorization() } }
            )

            permissionRow(
                title: "Notifications",
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

            // Apple's own labels. A token's name cannot be read — that is
            // the whole point of the design — but the system will draw it.
            //
            // Swipe to remove, which is the only per-platform control this API
            // can support. Apple's picker is all-or-nothing per visit and
            // returns an opaque set; nothing in the app can construct a token
            // for "the X app" or tell one token from another. What it CAN do is
            // drop one the user no longer wants gated — which is the difference
            // between "I gave Screen Time permission" and "shield everything I
            // happened to tick".
            //
            // Keyed by token rather than by index: `Set` has no stable order,
            // so an index-based delete removes whichever row the set felt like
            // ordering there this time.
            ForEach(Array(gate.selection.applicationTokens), id: \.self) { token in
                Label(token)
                    .labelStyle(.titleAndIcon)
                    .swipeActions(edge: .trailing) {
                        Button("Remove", role: .destructive) { remove(app: token) }
                    }
            }

            ForEach(Array(gate.selection.categoryTokens), id: \.self) { token in
                Label(token)
                    .labelStyle(.titleAndIcon)
                    .swipeActions(edge: .trailing) {
                        Button("Remove", role: .destructive) { remove(category: token) }
                    }
            }
        } header: {
            Text(gatedHeader)
        }
    }

    private var timingSection: some View {
        Section {
            // Tagged in seconds — see GateController.checkInStepSeconds. The
            // real options are all whole minutes; only the DEBUG ones are not.
            // Tagged in seconds — see GateController.checkInStepSeconds,
            // which keeps the unit only because `Gate` stores a sub-minute
            // developer override that the UI no longer offers.
            Picker("Check in every", selection: Binding(
                get: { gate.checkInStepSeconds },
                set: { gate.checkInStepSeconds = $0 }
            )) {
                Text("Never").tag(0)
                ForEach([2, 5, 10, 15], id: \.self) { Text("\($0) min").tag($0 * 60) }
            }
        }
    }

    private var customizeSection: some View {
        Section {
            // Optional, and empty by default. A door that knows your name is
            // friendlier than one that does not, and the shield is a moment
            // where friendliness does real work — but being greeted by name is
            // a nicety some people find grating, so blank is the right default.
            GateNameField(text: $name, onCommit: commitName)
                .onDisappear { commitName() }

            ShieldTintPicker(selection: $tint, name: name)
                .onChange(of: tint) { _, newValue in
                    Gate.shieldTint = newValue
                    // The home-screen tiles read the same pair. Widget
                    // timelines are cached until something asks otherwise, so
                    // without this the row keeps yesterday's colour until iOS
                    // happens to refresh it.
                    WidgetCenter.shared.reloadAllTimelines()
                }
        }
    }

    /// Stop gating one app, leaving the rest of the selection alone.
    ///
    /// Goes through `gate.save` rather than mutating in place so the shield is
    /// re-applied to the smaller set immediately — otherwise the removed app
    /// stays shielded until something else happens to write the store.
    private func remove(app token: ApplicationToken) {
        var updated = gate.selection
        updated.applicationTokens.remove(token)
        gate.save(selection: updated)
    }

    private func remove(category token: ActivityCategoryToken) {
        var updated = gate.selection
        updated.categoryTokens.remove(token)
        gate.save(selection: updated)
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
                               state: PermissionState,
                               ask: @escaping () -> Void) -> some View {
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

#if os(iOS)
// MARK: - The name field

/// UIKit-backed, like the two other text inputs in this app
/// (PersistentKeyboardTextField and URLBarTextField in FilterPhraseSheet).
///
/// A SwiftUI TextField here took seconds to raise a keyboard. Two things in
/// that path are gone now:
///
/// `.toolbar(placement: .keyboard)` builds its accessory by standing up a
/// UIHostingController, and the keyboard cannot present until that has been
/// built and laid out. A UIToolbar assigned to `inputAccessoryView` is a plain
/// view that already exists by the time the field is touched.
///
/// `@FocusState` re-evaluates the enclosing body on every focus change, and the
/// body here is four List sections including the app-token rows, each of which
/// asks the Screen Time daemon what to draw. Focus is now the text field's own
/// business and nothing above it re-renders.
struct GateNameField: UIViewRepresentable {
    @Binding var text: String
    var onCommit: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.delegate = context.coordinator
        field.font = .preferredFont(forTextStyle: .body)
        field.adjustsFontForContentSizeCategory = true
        field.textColor = .label
        field.attributedPlaceholder = NSAttributedString(
            string: "Your name",
            attributes: [.foregroundColor: UIColor.placeholderText]
        )
        field.autocapitalizationType = .words
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.returnKeyType = .done
        field.clearButtonMode = .whileEditing
        field.text = text
        field.addTarget(context.coordinator,
                        action: #selector(Coordinator.editingChanged(_:)),
                        for: .editingChanged)

        // Onboarding has no navigation bar and its Next button sits under the
        // keyboard, so the way out has to travel with the keyboard itself.
        let bar = UIToolbar()
        bar.items = [
            UIBarButtonItem(barButtonSystemItem: .flexibleSpace, target: nil, action: nil),
            UIBarButtonItem(barButtonSystemItem: .done,
                            target: context.coordinator,
                            action: #selector(Coordinator.done)),
        ]
        bar.sizeToFit()
        field.inputAccessoryView = bar

        context.coordinator.field = field
        return field
    }

    func updateUIView(_ uiView: UITextField, context: Context) {
        // Keep the coordinator's closure current; it is captured, not looked up.
        context.coordinator.parent = self
        // Only when it actually differs — assigning while editing would move
        // the caret to the end mid-word.
        if uiView.text != text { uiView.text = text }
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: GateNameField
        weak var field: UITextField?

        init(_ parent: GateNameField) { self.parent = parent }

        @objc func editingChanged(_ field: UITextField) {
            parent.text = field.text ?? ""
        }

        @objc func done() { field?.resignFirstResponder() }

        func textFieldShouldReturn(_ field: UITextField) -> Bool {
            field.resignFirstResponder()
            return false
        }

        /// The one place the name is persisted — see GateSetupSections.commitName.
        func textFieldDidEndEditing(_ field: UITextField) {
            parent.text = field.text ?? ""
            parent.onCommit()
        }
    }
}
#endif
