//
//  ShieldTintPicker.swift
//  iOS (App)
//
//  Choosing what the shield looks like, and showing what that choice does.
//
//  The shield is the one Bouncer surface the user does not visit — it arrives,
//  in another app, at a moment they were reaching for something else. So the
//  colour is picked here, where they cannot see it, which makes the preview
//  underneath the swatches the load-bearing part of this file rather than a
//  garnish: without it, five dots are five guesses.
//
//  The preview is a drawing, not the real thing. iOS renders the shield itself
//  from a `ShieldConfiguration` and there is no way to ask it for a picture, so
//  this reproduces the arrangement — ground, greeting, two buttons — from the
//  same `Gate.ShieldTint` the extension reads. Keep the two in step: if
//  ShieldConfigurationExtension changes which half of the pair paints what,
//  this has to change with it or the preview starts lying.
//

import SwiftUI

extension Gate.ShieldTint {
    /// The light half — title, icon, primary button fill.
    var accentColor: Color {
        Color(red: accent.red, green: accent.green, blue: accent.blue)
    }

    /// The dark half — the ground, and the type on the primary button.
    var inkColor: Color {
        Color(red: ink.red, green: ink.green, blue: ink.blue)
    }
}

/// A row of swatches over a miniature of the shield they produce.
struct ShieldTintPicker: View {
    @Binding var selection: Gate.ShieldTint

    /// What the greeting reads as. Passed in rather than read from `Gate` so
    /// the preview can show the name the user is typing on the same screen,
    /// before it has been committed anywhere.
    var name: String?

    var body: some View {
        VStack(spacing: 14) {
            HStack(spacing: 16) {
                ForEach(Gate.ShieldTint.allCases, id: \.self) { tint in
                    Button {
                        selection = tint
                    } label: {
                        Swatch(tint: tint, isSelected: tint == selection)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(tint.displayName)
                    .accessibilityAddTraits(tint == selection ? [.isSelected] : [])
                }
            }
            .frame(maxWidth: .infinity)

            ShieldPreview(tint: selection, name: name)
        }
        .padding(.vertical, 6)
        .animation(.easeOut(duration: 0.25), value: selection)
    }
}

// MARK: - One swatch

/// Both halves of the pair, because the pair is what is being chosen: the ring
/// is the ground the shield sits on, the dot is what gets written on it.
private struct Swatch: View {
    let tint: Gate.ShieldTint
    let isSelected: Bool

    var body: some View {
        ZStack {
            Circle()
                .fill(tint.inkColor)
                .frame(width: 34, height: 34)
            Circle()
                .fill(tint.accentColor)
                .frame(width: 15, height: 15)
        }
        .padding(4)
        .overlay {
            Circle()
                .strokeBorder(Color.accentColor, lineWidth: isSelected ? 2.5 : 0)
        }
        .contentShape(Circle())
    }
}

// MARK: - The miniature

private struct ShieldPreview: View {
    let tint: Gate.ShieldTint
    let name: String?

    /// The shield's own copy, kept identical to
    /// ShieldConfigurationExtension.titleText().
    private var title: String {
        guard let name, !name.trimmingCharacters(in: .whitespaces).isEmpty else {
            return "What are you here for?"
        }
        return "Hey \(name.trimmingCharacters(in: .whitespaces)),\nwhat are you here for?"
    }

    var body: some View {
        VStack(spacing: 12) {
            Text(title)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(tint.accentColor)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            VStack(spacing: 8) {
                Text("View in X")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(tint.inkColor)
                    .padding(.vertical, 7)
                    .frame(maxWidth: .infinity)
                    .background(tint.accentColor, in: Capsule())

                // Plain type, no fill — iOS gives the secondary button no
                // background colour, so this is the whole of what it can be.
                Text("View in Bouncer")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(tint.accentColor)
            }
            .padding(.horizontal, 28)
        }
        .padding(.vertical, 22)
        .frame(maxWidth: .infinity)
        .background(tint.inkColor)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Preview of the \(tint.displayName) shield")
    }
}
