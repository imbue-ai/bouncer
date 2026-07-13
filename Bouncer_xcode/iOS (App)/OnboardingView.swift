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
    @State private var inferenceMode: InferenceMode = .cloud
    // True once the user commits to Local and the model transfer starts;
    // onboarding then blocks on the download and auto-finishes when it lands.
    @State private var isDownloadingModel = false
    @ObservedObject private var localService = LocalInferenceService.shared
    private let pageCount = 5

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
                    subtitle: "See all your removed posts in one place and restore any you want back.",
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

                InferenceModePage(
                    mode: $inferenceMode,
                    isDownloading: $isDownloadingModel,
                    localService: localService
                )
                .tag(4)
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
                    handlePrimaryTap()
                } label: {
                    Text(primaryButtonLabel)
                        .font(.system(size: 18, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(Color.accentColor.opacity(isPrimaryButtonDisabled ? 0.5 : 1))
                        .foregroundColor(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .disabled(isPrimaryButtonDisabled)
                .padding(.horizontal, 24)
            }
            .padding(.bottom, 50)
        }
        .background(Color(UIColor.systemBackground))
        // Local path: the Get Started tap only starts the model download;
        // onboarding completes on its own once the file lands.
        .onChange(of: localService.modelStatus) { _, newStatus in
            guard isDownloadingModel else { return }
            if newStatus == .downloaded || newStatus == .ready {
                completeOnboarding()
            }
        }
    }

    private var isLastPage: Bool { currentPage == pageCount - 1 }

    private var primaryButtonLabel: String {
        guard isLastPage else { return "Next" }
        guard isDownloadingModel else { return "Get Started" }
        switch localService.modelStatus {
        case .downloading: return "Downloading…"
        case .paused: return "Resume"
        case .downloaded, .loading, .ready: return "Get Started"
        case .notDownloaded, .error: return "Retry"
        }
    }

    private var isPrimaryButtonDisabled: Bool {
        if isLastPage, isDownloadingModel,
           case .downloading = localService.modelStatus { return true }
        return false
    }

    private func handlePrimaryTap() {
        guard isLastPage else {
            currentPage += 1
            return
        }

        if isDownloadingModel {
            switch localService.modelStatus {
            case .downloaded, .loading, .ready:
                completeOnboarding()
            default:
                // Paused or failed — resume/restart the transfer.
                localService.startDownload(LocalInferenceService.models[0])
            }
            return
        }

        switch inferenceMode {
        case .cloud:
            writeSelectedModel(imbueModelKey)
            completeOnboarding()
        case .onDevice:
            // Unreachable via UI (unsupported devices never see the On-Device
            // option), but keep the RAM invariant local to the write.
            guard LocalInferenceService.models[0].isSupportedOnThisDevice else { return }
            writeSelectedModel(LocalInferenceService.models[0].selectedModelKey)
            switch localService.downloadStatus(for: LocalInferenceService.models[0]) {
            case .downloaded, .loading, .ready:
                // Already on disk (e.g. onboarding re-run) — nothing to fetch.
                completeOnboarding()
            default:
                isDownloadingModel = true
                localService.startDownload(LocalInferenceService.models[0])
            }
        }
    }

    private func completeOnboarding() {
        videoPlayer.stop()
        UserDefaults.standard.set(true, forKey: "hasCompletedOnboarding")
        withAnimation(.easeOut(duration: 0.35)) {
            isOnboarded = true
        }
    }

    // Native side of the chrome.storage.local backing store (the
    // feedfilterStorage bridge in FilteredWebView) — no WebView is mounted
    // during onboarding, so write UserDefaults directly. Values are the
    // JSON strings the ChromePolyfill would send, hence the added quotes.
    private func writeSelectedModel(_ modelKey: String) {
        UserDefaults.standard.set("\"\(modelKey)\"", forKey: "ffstore_ff_local_selectedModel")
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

// MARK: - Inference Mode Page (Cloud vs On-Device)

private enum InferenceMode {
    case cloud, onDevice
}

private struct InferenceModePage: View {
    @Binding var mode: InferenceMode
    @Binding var isDownloading: Bool
    @ObservedObject var localService: LocalInferenceService

    var body: some View {
        VStack(spacing: 8) {
            VStack(spacing: 12) {
                Text("Choose Filtering Mode")
                    .font(.system(size: 28, weight: .bold))
                    .multilineTextAlignment(.center)

                Text("You can change this anytime in settings.")
                    .font(.system(size: 17))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }
            .padding(.top, 60)

            // iOS has no radio-button control; the system idiom for a
            // single choice is an inline Picker in an inset-grouped list
            // (checkmark rows, as in Settings).
            List {
                Section {
                    Picker("AI mode", selection: $mode) {
                        option(
                            title: "Cloud",
                            description: "Fast, free filtering in the cloud.",
                            badge: "Recommended",
                            badgeTint: .green
                        )
                        .tag(InferenceMode.cloud)

                        // Inline-Picker rows can't be individually disabled,
                        // so on low-RAM devices the On-Device option is omitted
                        // and the footer below explains why.
                        if LocalInferenceService.models[0].isSupportedOnThisDevice {
                            option(
                                title: "On-Device",
                                description: "Runs entirely on your device — no posts ever leave your phone.",
                                // Badge shows the bare size — the estimate's "~" reads as clutter here.
                                badge: "\(LocalInferenceService.models[0].approxSize.replacingOccurrences(of: "~", with: "")) download",
                                badgeIcon: "arrow.down.circle"
                            )
                            .tag(InferenceMode.onDevice)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    .disabled(isDownloading)
                } footer: {
                    if !LocalInferenceService.models[0].isSupportedOnThisDevice {
                        Text("On-device filtering isn't available on this iPhone — it requires \(LocalInferenceService.models[0].requiredRAMDisplay)+ RAM. You can use Cloud mode instead.")
                    }
                }

                if isDownloading {
                    Section {
                        // Still the system linear ProgressView — iOS has no
                        // thickness API, so scale the stock bar up and glide
                        // between the downloader's 0.5s progress ticks.
                        ProgressView(value: downloadProgress)
                            .scaleEffect(x: 1, y: 2.75, anchor: .center)
                            .padding(.vertical, 8)
                            .animation(.easeInOut(duration: 0.45), value: downloadProgress)

                        Text(statusText)
                            .font(.footnote)
                            .foregroundStyle(isError ? Color.red : Color.secondary)

                        Button("Cancel download", role: .destructive) {
                            localService.cancelDownload()
                            isDownloading = false
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .scrollBounceBehavior(.basedOnSize)
            .animation(.easeInOut(duration: 0.2), value: isDownloading)
        }
    }

    private func option(
        title: String,
        description: String,
        badge: String? = nil,
        badgeIcon: String? = nil,
        badgeTint: Color? = nil
    ) -> some View {
        // System Dynamic Type styles, so the rows scale with the user's
        // text-size setting like any Settings row would.
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.title3.weight(.semibold))
                if let badge {
                    // Tinted capsule (system color on its own low-opacity
                    // fill) is the App Store-style tag idiom; untinted falls
                    // back to the neutral gray pill.
                    badgeLabel(badge, systemImage: badgeIcon)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(badgeTint ?? Color.secondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(
                            badgeTint?.opacity(0.15) ?? Color(UIColor.tertiarySystemFill),
                            in: Capsule()
                        )
                }
            }
            Text(description)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 6)
    }

    private func badgeLabel(_ badge: String, systemImage: String?) -> Text {
        guard let systemImage else { return Text(badge) }
        // Inline symbol interpolation, not Label — inside a List, Label
        // reserves the list's icon-alignment column, which reads as a gap
        // between the symbol and the text.
        return Text("\(Image(systemName: systemImage)) \(badge)")
    }

    private var downloadProgress: Double {
        switch localService.modelStatus {
        case .downloading(let progress), .paused(let progress): return progress
        case .downloaded, .loading, .ready: return 1
        case .notDownloaded, .error: return 0
        }
    }

    private var statusText: String {
        switch localService.modelStatus {
        case .downloading(let progress):
            let pct = Int((progress * 100).rounded())
            return "Downloading \(pct)% — \(localService.downloadedBytesDisplay) / \(localService.totalBytesDisplay)"
        case .paused(let progress):
            let pct = Int((progress * 100).rounded())
            return "Paused at \(pct)%"
        case .downloaded, .loading, .ready:
            return "Download complete"
        case .error(let message):
            return message
        case .notDownloaded:
            return "Starting download…"
        }
    }

    private var isError: Bool {
        if case .error = localService.modelStatus { return true }
        return false
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
