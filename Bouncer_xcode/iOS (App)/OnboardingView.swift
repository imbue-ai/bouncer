//
//  OnboardingView.swift
//  iOS (App)
//
//  Native onboarding slideshow shown on first launch.
//

import SwiftUI
import AVFoundation

struct OnboardingView: View {
    @Binding var isOnboarded: Bool

    @State private var currentPage = 0
    @State private var videoPlayer = PreloadedVideoPlayer(videoName: "filterphrases")
    private let pageCount = 4

    var body: some View {
        VStack(spacing: 0) {
            TabView(selection: $currentPage) {
                WelcomePage()
                    .tag(0)

                VideoOnboardingPage(
                    title: "Add Filters",
                    subtitle: "Hide relevant posts automatically.",
                    player: videoPlayer,
                    pageIndex: 1
                )
                .tag(1)

                OnboardingPage(
                    title: "View Filtered",
                    subtitle: "See all your bounced posts in one place and restore any you want back.",
                    imageName: "onboarding-view-filtered",
                    pageIndex: 2
                )
                .tag(2)

                OnboardingPage(
                    title: "Bounce This Post",
                    subtitle: "Tap the trash icon on any post to bounce it from your feed.",
                    imageName: "onboarding-bounce",
                    pageIndex: 3
                )
                .tag(3)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .animation(.easeInOut(duration: 0.3), value: currentPage)

            // Bottom controls
            VStack(spacing: 20) {
                // Page indicator dots
                HStack(spacing: 8) {
                    ForEach(0..<pageCount, id: \.self) { index in
                        Circle()
                            .fill(index == currentPage ? Color.accentColor : Color(UIColor.tertiaryLabel))
                            .frame(width: 8, height: 8)
                            .animation(.easeInOut(duration: 0.2), value: currentPage)
                    }
                }

                Button {
                    if currentPage < pageCount - 1 {
                        currentPage += 1
                    } else {
                        videoPlayer.stop()
                        UserDefaults.standard.set(true, forKey: "hasCompletedOnboarding")
                        withAnimation(.easeOut(duration: 0.35)) {
                            isOnboarded = true
                        }
                    }
                } label: {
                    Text(currentPage < pageCount - 1 ? "Next" : "Get Started")
                        .font(.system(size: 18, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(Color.accentColor)
                        .foregroundColor(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .padding(.horizontal, 24)
            }
            .padding(.bottom, 50)
        }
        .background(Color(UIColor.systemBackground))
    }
}

// MARK: - Welcome Page (text-only)

private struct WelcomePage: View {
    private static let phrases = [
        "negativity",
        "ragebait",
        "politics",
        "pessimism",
        "virtue signaling",
        "humblebragging",
        "engagement bait",
    ]

    @State private var displayedText = ""
    @State private var phraseIndex = 0
    @State private var charIndex = 0
    @State private var isDeleting = false
    @State private var cursorVisible = true
    @State private var timer: Timer?
    @State private var cursorTimer: Timer?

    private let typingSpeed: TimeInterval = 0.06
    private let deletingSpeed: TimeInterval = 0.035
    private let pauseAfterTyping: TimeInterval = 1.8
    private let pauseAfterDeleting: TimeInterval = 0.3

    var body: some View {
        VStack(spacing: 16) {
            Spacer()

            VStack(spacing: 0) {
                Text("Welcome to")
                    .font(.system(size: 36, weight: .medium))
                    .foregroundStyle(.secondary)

                Text("Bouncer")
                    .font(.system(size: 52, weight: .bold))
            }

            VStack(spacing: 4) {
                Text("Social media, without the")
                    .font(.system(size: 22, weight: .regular))
                    .foregroundStyle(.secondary)

                (Text(displayedText)
                    .font(.system(size: 22, weight: .semibold))
                 + Text("|")
                    .font(.system(size: 22, weight: .regular))
                    .foregroundColor(cursorVisible ? .accentColor : .clear))
                    .animation(.none, value: cursorVisible)

                // Underline
                Rectangle()
                    .fill(Color.accentColor.opacity(0.4))
                    .frame(width: 200, height: 2)
            }
            .padding(.top, 8)

            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .onAppear {
            startTyping()
            cursorTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
                cursorVisible.toggle()
            }
        }
        .onDisappear {
            timer?.invalidate()
            cursorTimer?.invalidate()
        }
    }

    private func startTyping() {
        let phrase = Self.phrases[phraseIndex]
        timer = Timer.scheduledTimer(withTimeInterval: typingSpeed, repeats: false) { _ in
            if charIndex < phrase.count {
                let idx = phrase.index(phrase.startIndex, offsetBy: charIndex + 1)
                displayedText = String(phrase[..<idx])
                charIndex += 1
                startTyping()
            } else {
                // Pause then start deleting
                timer = Timer.scheduledTimer(withTimeInterval: pauseAfterTyping, repeats: false) { _ in
                    isDeleting = true
                    startDeleting()
                }
            }
        }
    }

    private func startDeleting() {
        let phrase = Self.phrases[phraseIndex]
        timer = Timer.scheduledTimer(withTimeInterval: deletingSpeed, repeats: false) { _ in
            if charIndex > 0 {
                charIndex -= 1
                let idx = phrase.index(phrase.startIndex, offsetBy: charIndex)
                displayedText = String(phrase[..<idx])
                startDeleting()
            } else {
                // Move to next phrase
                isDeleting = false
                phraseIndex = (phraseIndex + 1) % Self.phrases.count
                timer = Timer.scheduledTimer(withTimeInterval: pauseAfterDeleting, repeats: false) { _ in
                    startTyping()
                }
            }
        }
    }
}

// MARK: - Preloaded Video Player (created once, shared)

private class PreloadedVideoPlayer {
    let player: AVQueuePlayer
    private var looper: AVPlayerLooper?

    init(videoName: String) {
        let queuePlayer = AVQueuePlayer()
        self.player = queuePlayer

        guard let url = Bundle.main.url(forResource: videoName, withExtension: "mp4") else {
            return
        }
        let item = AVPlayerItem(url: url)
        self.looper = AVPlayerLooper(player: queuePlayer, templateItem: item)
        queuePlayer.play()
    }

    func stop() {
        player.pause()
        player.removeAllItems()
        looper = nil
    }
}

// MARK: - Looping Video View

private struct LoopingVideoView: UIViewRepresentable {
    let player: AVQueuePlayer

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        let playerLayer = AVPlayerLayer(player: player)
        playerLayer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(playerLayer)
        context.coordinator.playerLayer = playerLayer
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        DispatchQueue.main.async {
            context.coordinator.playerLayer?.frame = uiView.bounds
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    class Coordinator {
        var playerLayer: AVPlayerLayer?
    }
}

// MARK: - Video Onboarding Page

private struct VideoOnboardingPage: View {
    let title: String
    let subtitle: String
    let player: PreloadedVideoPlayer
    let pageIndex: Int

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 24) {
                Spacer()

                LoopingVideoView(player: player.player)
                    .frame(maxWidth: geo.size.width * 0.85, maxHeight: geo.size.height * 0.65)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(Color(UIColor.separator), lineWidth: 0.5)
                    )

                VStack(spacing: 12) {
                    Text(title)
                        .font(.system(size: 28, weight: .bold))
                        .multilineTextAlignment(.center)

                    Text(subtitle)
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
    }
}

// MARK: - Single Onboarding Page

private struct OnboardingPage: View {
    let title: String
    let subtitle: String
    let imageName: String
    let pageIndex: Int

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 24) {
                Spacer()

                Image(imageName)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: geo.size.width * 0.85, maxHeight: geo.size.height * 0.65)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(Color(UIColor.separator), lineWidth: 0.5)
                    )

                VStack(spacing: 12) {
                    Text(title)
                        .font(.system(size: 28, weight: .bold))
                        .multilineTextAlignment(.center)

                    Text(subtitle)
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
    }
}
