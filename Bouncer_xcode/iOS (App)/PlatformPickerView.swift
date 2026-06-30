//
//  PlatformPickerView.swift
//  iOS (App)
//
//  Full-screen picker for switching the WebView between supported platforms.
//  Shown on first launch (after onboarding) and again when the user taps the
//  Home button in the filter sheet. Selecting a row navigates the WebView to
//  that platform's feed URL and dismisses the picker. Filter phrases follow
//  automatically because they're keyed per platform in chrome.storage.local
//  (`descriptions_<siteId>`).
//
//  Styled to match OnboardingPage so the launch-flow visual language is
//  consistent: system background, centered 28pt title + 17pt secondary
//  subtitle, and a rounded card with the same corner radius / separator
//  stroke as the onboarding image cards.
//

import SwiftUI

// MARK: - Platform Picker

struct PlatformPickerView: View {
    // String IDs match FilterSheetViewModel.selectedPlatform values
    // ("twitter", "youtube", "linkedin"), so callers can pass the result
    // straight to viewModel.selectPlatform without translation.
    let onSelect: (String) -> Void

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 24) {
                Spacer()

                platformCard
                    .frame(maxWidth: geo.size.width * 0.85)

                VStack(spacing: 12) {
                    Text("Pick a Platform")
                        .font(.system(size: 28, weight: .bold))
                        .multilineTextAlignment(.center)

                    Text("Choose a feed to start filtering. You can switch anytime from the home button.")
                        .font(.system(size: 17))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }

                Spacer()
                Spacer()
            }
            .frame(maxWidth: .infinity)
        }
        .background(Color(UIColor.systemBackground))
    }

    private var platformCard: some View {
        VStack(spacing: 0) {
            // Rows come from the platform registry — adding a new platform
            // doesn't require touching this view.
            ForEach(Platforms.all.indices, id: \.self) { idx in
                if idx > 0 { divider }
                row(
                    label: Platforms.all[idx].displayName,
                    platformId: Platforms.all[idx].id
                )
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(Color(UIColor.separator), lineWidth: 0.5)
        )
    }

    private var divider: some View {
        Rectangle()
            .fill(Color(UIColor.separator))
            .frame(height: 0.5)
    }

    private func row(label: String, platformId: String) -> some View {
        Button {
            onSelect(platformId)
        } label: {
            HStack {
                Text(label)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(.primary)
                Spacer()
                Image(systemName: "arrow.right")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 22)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
