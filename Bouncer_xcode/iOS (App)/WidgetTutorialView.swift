//
//  WidgetTutorialView.swift
//  iOS (App)
//
//  How to put Bouncer's row of tiles on the home screen, shown rather than
//  written down.
//
//  Four steps that only exist because iOS hides them: a long press with no
//  affordance, an Edit button that appears once you are already in a mode you
//  did not know you had entered, and a gallery you have to search. Written out
//  as a list this reads as five lines nobody follows; animated, it is a thing
//  you have watched someone do, which is how anybody actually learns a gesture.
//
//  The phone here is a drawing — no screenshots. Screenshots of the home screen
//  age out with every iOS release and carry whatever apps happened to be on the
//  device they were taken from; a diagram stays true to the gesture, which is
//  the part that does not change.
//

import SwiftUI

struct WidgetTutorialView: View {

    @Environment(\.dismiss) private var dismiss
    @State private var step = 0

    /// Auto-advancing, and looping. Nobody taps Next through a tutorial they
    /// opened out of curiosity — and the loop means arriving mid-way costs
    /// nothing, because it comes round again.
    private let steps: [Step] = [
        Step(caption: "Touch and hold an empty spot on your home screen.",
             detail: "The icons start to wiggle."),
        Step(caption: "Tap **Edit** at the top left, then **Add Widget**.",
             detail: "That opens the widget gallery."),
        Step(caption: "Search for **Bouncer** and pick **Your feeds**.",
             detail: "It comes in one size, the wide one."),
        Step(caption: "Tap **Add Widget**, then **Done**.",
             detail: "Long-press it later to choose which platforms it shows."),
    ]

    struct Step {
        let caption: String
        let detail: String
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Spacer(minLength: 8)

                PhoneMock(step: step)
                    .frame(width: 240, height: 400)
                    .animation(.easeInOut(duration: 0.45), value: step)

                Spacer(minLength: 8)

                VStack(spacing: 8) {
                    Text(.init(steps[step].caption))
                        .font(.system(size: 18, weight: .semibold))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)

                    Text(steps[step].detail)
                        .font(.system(size: 15))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                // A fixed height so the phone above does not shuffle up and
                // down as captions of different lengths come and go.
                .frame(height: 76, alignment: .top)
                .padding(.horizontal, 28)
                .id(step)
                .transition(.opacity)
                .animation(.easeInOut(duration: 0.3), value: step)

                HStack(spacing: 8) {
                    ForEach(steps.indices, id: \.self) { index in
                        Capsule()
                            .fill(index == step ? Color.accentColor : Color(UIColor.tertiaryLabel))
                            .frame(width: index == step ? 20 : 7, height: 7)
                            .animation(.easeInOut(duration: 0.3), value: step)
                    }
                }
                .padding(.top, 18)
                .padding(.bottom, 24)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(UIColor.systemBackground))
            .navigationTitle("Add the widget")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            // Tap anywhere to move on, for anyone who reads faster than the
            // timer runs.
            .contentShape(Rectangle())
            .onTapGesture { advance() }
            .task {
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 2_600_000_000)
                    if Task.isCancelled { return }
                    advance()
                }
            }
        }
    }

    private func advance() {
        withAnimation { step = (step + 1) % steps.count }
    }
}

// MARK: - The phone

/// A home screen, drawn. Each step changes what is on it and the animation
/// between them carries the meaning — icons starting to wiggle IS the answer to
/// "how do I know the long press worked".
private struct PhoneMock: View {
    let step: Int

    /// Wiggle mode, which the last step has left: by then Done has been
    /// tapped and the home screen is back to normal with the widget on it.
    private var isEditing: Bool { (1...2).contains(step) }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 34, style: .continuous)
                .fill(
                    LinearGradient(colors: [Color(white: 0.22), Color(white: 0.10)],
                                   startPoint: .top, endPoint: .bottom)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 34, style: .continuous)
                        .strokeBorder(Color(UIColor.separator), lineWidth: 1)
                }

            VStack(spacing: 0) {
                // The Edit control, which only exists in wiggle mode.
                HStack {
                    if isEditing {
                        pill("Edit", filled: step == 1)
                            .transition(.scale(scale: 0.7).combined(with: .opacity))
                    }
                    Spacer()
                }
                .frame(height: 26)
                .padding(.horizontal, 14)
                .padding(.top, 14)

                Spacer(minLength: 0)

                content
                    .padding(.horizontal, 16)

                Spacer(minLength: 0)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch step {
        case 0, 1:
            IconGrid(wiggling: isEditing, pressing: step == 0)
        case 2:
            GalleryMock()
        default:
            IconGrid(wiggling: false, pressing: false, showsWidget: true)
        }
    }

    private func pill(_ text: String, filled: Bool) -> some View {
        Text(text)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(filled ? Color.black : Color.white)
            .padding(.vertical, 5)
            .padding(.horizontal, 12)
            .background(filled ? Color.white : Color.white.opacity(0.22), in: Capsule())
    }
}

/// Four rows of blank icons, optionally wiggling, optionally with the finished
/// widget dropped in at the top.
private struct IconGrid: View {
    let wiggling: Bool
    let pressing: Bool
    var showsWidget: Bool = false

    @State private var wiggle = false
    @State private var pressScale: CGFloat = 1

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 12), count: 4)

    var body: some View {
        VStack(spacing: 14) {
            if showsWidget {
                WidgetMock()
                    .transition(.scale(scale: 0.8).combined(with: .opacity))
            }

            LazyVGrid(columns: columns, spacing: 14) {
                ForEach(0..<(showsWidget ? 8 : 12), id: \.self) { index in
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(Color.white.opacity(0.16))
                        .aspectRatio(1, contentMode: .fit)
                        .rotationEffect(.degrees(wiggling && wiggle
                                                 ? (index.isMultiple(of: 2) ? 1.6 : -1.6)
                                                 : 0))
                }
            }
            .animation(wiggling
                       ? .easeInOut(duration: 0.13).repeatForever(autoreverses: true)
                       : .default,
                       value: wiggle)
        }
        // The finger. A circle is enough — it is standing in for a touch, and
        // anything more literal reads as a cursor.
        .overlay(alignment: .center) {
            if pressing {
                Circle()
                    .fill(Color.white.opacity(0.28))
                    .frame(width: 46, height: 46)
                    .scaleEffect(pressScale)
                    .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true),
                               value: pressScale)
            }
        }
        .onAppear {
            wiggle = true
            pressScale = 1.35
        }
    }
}

/// The widget gallery, mid-search.
private struct GalleryMock: View {
    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 11, weight: .semibold))
                Text("Bouncer")
                    .font(.system(size: 12, weight: .medium))
                Spacer()
            }
            .foregroundStyle(.white.opacity(0.75))
            .padding(.vertical, 7)
            .padding(.horizontal, 10)
            .background(Color.white.opacity(0.16), in: Capsule())

            WidgetMock()

            Text("Your feeds")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white.opacity(0.85))

            Text("Add Widget")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.black)
                .padding(.vertical, 6)
                .padding(.horizontal, 16)
                .background(Color.white, in: Capsule())
        }
        .transition(.opacity)
    }
}

/// The row of tiles as it will appear, in whatever colour the shield is wearing.
private struct WidgetMock: View {
    private var tint: Gate.ShieldTint { Gate.shieldTint }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(["X", "IG", "in"], id: \.self) { mark in
                VStack(spacing: 4) {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(tint.accentColor)
                        .frame(width: 30, height: 30)
                        .overlay {
                            Text(mark)
                                .font(.system(size: 13, weight: .bold, design: .rounded))
                                .foregroundStyle(tint.inkColor)
                                .minimumScaleFactor(0.7)
                                .lineLimit(1)
                        }
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .background(tint.inkColor, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
