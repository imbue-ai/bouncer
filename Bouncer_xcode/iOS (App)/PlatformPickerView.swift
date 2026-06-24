//
//  PlatformPickerView.swift
//  iOS (App)
//
//  Full-screen picker for switching the WebView between supported platforms.
//  Shown when the user taps the Home button in the filter sheet; selecting a
//  row navigates the WebView to that platform's feed URL and dismisses the
//  picker. Filter phrases follow automatically because they're keyed per
//  platform in chrome.storage.local (`descriptions_<siteId>`).
//

import SwiftUI

// MARK: - Platform Picker

struct PlatformPickerView: View {
    // String IDs match FilterSheetViewModel.selectedPlatform values
    // ("twitter", "youtube", "linkedin"), so callers can pass the result
    // straight to viewModel.selectPlatform without translation.
    let onSelect: (String) -> Void

    private let orange = Color(red: 234 / 255, green: 133 / 255, blue: 84 / 255)

    var body: some View {
        ZStack {
            orange.ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                Spacer()

                Text("Bouncer")
                    .font(.system(size: 52, weight: .bold))
                    .foregroundColor(.white)
                    .padding(.bottom, 16)

                CatchUpSubtitle()
                    .padding(.bottom, 44)

                VStack(spacing: 0) {
                    // Rows come from the platform registry — adding a new
                    // platform doesn't require touching this view.
                    ForEach(Platforms.all.indices, id: \.self) { idx in
                        if idx > 0 { divider }
                        row(
                            label: Platforms.all[idx].displayName,
                            platformId: Platforms.all[idx].id
                        )
                    }
                }

                Spacer()
                Spacer()
            }
            .padding(.horizontal, 32)
        }
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.white.opacity(0.3))
            .frame(height: 0.5)
    }

    private func row(label: String, platformId: String) -> some View {
        Button {
            onSelect(platformId)
        } label: {
            HStack {
                Text(label)
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundColor(.white)
                Spacer()
                Image(systemName: "arrow.right")
                    .font(.system(size: 22, weight: .medium))
                    .foregroundColor(.white.opacity(0.65))
            }
            .padding(.vertical, 22)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Animated subtitle

private struct CatchUpSubtitle: View {
    private let words = [
        "the world",
        "real people",
        "breaking news",
        "frontier science",
        "the latest trends",
        "new music",
        "pop culture",
    ]

    private let lineHeight: CGFloat = 32
    private let animDuration: TimeInterval = 0.45
    private let holdDuration: TimeInterval = 2.2

    @State private var currentIndex = 0
    @State private var timer: Timer?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Hey there, catch up on")
                .font(.system(size: 20, weight: .regular))
                .foregroundColor(.white.opacity(0.88))

            // Clipped viewport — same as CSS overflow:hidden on the track.
            ZStack(alignment: .topLeading) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(words, id: \.self) { word in
                        Text(word)
                            .font(.system(size: 24, weight: .semibold))
                            .foregroundColor(.white)
                            .frame(height: lineHeight, alignment: .leading)
                    }
                }
                .offset(y: -CGFloat(currentIndex) * lineHeight)
                .animation(.easeInOut(duration: animDuration), value: currentIndex)
            }
            .frame(height: lineHeight, alignment: .top)
            .clipped()

            Text("…without the noise.")
                .font(.system(size: 20, weight: .regular))
                .foregroundColor(.white.opacity(0.88))
        }
        .onAppear { startCycle() }
        .onDisappear { timer?.invalidate() }
    }

    private func startCycle() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: holdDuration, repeats: true) { _ in
            currentIndex = (currentIndex + 1) % words.count
        }
    }
}
