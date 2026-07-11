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

    @State private var showingDebug = false

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

                // Developer entry point: load downloaded on-device models and
                // benchmark them against ad-hoc prompts. Dev (Debug) builds
                // only — compiled out of Release/Prod entirely.
                #if DEBUG
                debugButton
                    .padding(.bottom, 12)
                #endif
            }
            .padding(.horizontal, 32)
        }
        #if DEBUG
        .fullScreenCover(isPresented: $showingDebug) {
            DebugView()
        }
        #endif
    }

    #if DEBUG
    private var debugButton: some View {
        Button {
            showingDebug = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "wrench.and.screwdriver")
                Text("Debug models")
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
            }
            .font(.system(size: 15, weight: .medium))
            .foregroundColor(.white.opacity(0.72))
            .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
    }
    #endif

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

#if DEBUG
// MARK: - Debug screen

/// Developer harness for the on-device models. Lists every downloaded variant,
/// lets you make one active, runs an ad-hoc prompt through it via
/// `LocalInferenceService.debugRun`, and displays the output plus timing /
/// token-throughput stats. "Run on all downloaded" sweeps every variant with
/// the same prompt so they can be compared head to head.
///
/// Note: running a model here switches the app's *active* selected model (the
/// same one the live filter uses) and persists that choice, since the engine
/// is a shared singleton. That's intentional for A/B testing.
struct DebugView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var service = LocalInferenceService.shared

    @State private var systemPrompt = DebugView.presets[0].system
    @State private var userPrompt = DebugView.presets[0].user
    @State private var maxTokens = 256
    @State private var results: [RunResult] = []
    @State private var isRunning = false
    @State private var runLabel = ""

    // AI-text detection (on-device detector) test state.
    @State private var detectionText = DebugView.detectionCases[0].text
    @State private var detectionResults: [DetectionRunResult] = []
    @State private var isDetecting = false
    @State private var detectionLabel = ""

    struct RunResult: Identifiable {
        let id = UUID()
        let taskName: String
        let stats: LocalInferenceService.InferenceStats
        let isError: Bool
    }

    // A labelled AI-text detection sample. `expected` is the ground-truth
    // verdict so the debug UI can show ✓/✗ against the calibrated thresholds.
    struct DetectionCase {
        let name: String
        let text: String
        let expected: LocalInferenceService.DetectionVerdict?   // nil = unlabeled (no ✓/✗)
    }
    static let detectionCases: [DetectionCase] = [
        DetectionCase(
            name: "Human (casual)",
            text: "honestly not sure why everyone's freaking out about this update, "
                + "it's fine? took me like 2 mins to get used to the new layout lol",
            expected: .human),
        DetectionCase(
            name: "AI-generated",
            text: "The recent update introduces a thoughtfully redesigned layout that "
                + "enhances usability. While change can feel unfamiliar at first, most "
                + "users will find the transition intuitive and the improvements worthwhile.",
            expected: .generated),
        DetectionCase(
            name: "AI-edited",
            text: "not gonna lie, I wasn't sure about this update at first. However, after "
                + "spending a couple of minutes with it, the new layout feels intuitive and "
                + "the transition was smoother than expected.",
            expected: .edited),
        // Real-world unlabeled samples (no ground truth → no ✓/✗, just the score).
        DetectionCase(name: "Tweet 1 (AI-first bet)", text: tweet1, expected: nil),
        DetectionCase(name: "Tweet 2 (decisions/leadership)", text: tweet2, expected: nil),
        DetectionCase(name: "Tweet 3 (the canary)", text: tweet3, expected: nil),
        DetectionCase(name: "Tweet 4 (shift/lean execution)", text: tweet4, expected: nil),
        DetectionCase(name: "Review (boots)", text: bootsReview, expected: nil),
        // Regression: a post far over the 1024-token context. The runtime must
        // truncate to the first ~1023 tokens (training-parity truncation=True)
        // instead of erroring "Input token ids are too long".
        DetectionCase(name: "Long post (truncation)",
                      text: Array(repeating: bootsReview, count: 30).joined(separator: " "),
                      expected: nil),
    ]

    // Tweet texts as multiline literals — referenced above. Kept out of the
    // array literal so long `+` chains don't blow up Swift's type-checker.
    private static let tweet1 = """
    This is a brutal but clear bet on an AI-first operating model. Cutting nearly half the company while saying "business is strong" signals this isn't cost panic it's structural redesign.

    Smaller teams + intelligence tooling as leverage. High risk, high conviction move. The real test won't be this quarter's margins, but whether execution speed and product quality actually compound from here.
    """
    private static let tweet2 = """
    Every decision carries consequences, whether positive or negative. Making them requires courage, clarity, and conviction.

    It is impossible to satisfy everyone. When a decision is not improvised but carefully assessed through a rigorous evaluation of risks and long term advantages, it reflects responsible leadership.

    A CEO's role is not to preserve comfort, but to ensure structural strength and future viability. Acting decisively, taking ownership, and addressing the organization directly demonstrate accountability.

    Leadership requires not only strategic vision, but also the willingness to stand behind difficult choices.

    Respect for taking responsibility and communicating transparently.
    """
    private static let tweet3 = """
    This is the canary. You're one of the first CEOs to say the quiet part out loud: "intelligence tools" + smaller, flatter teams mean thousands of knowledge workers are now optional, even when the business is healthy. A lot of people are still treating AI as a side project. They shouldn't be. This was very kind to far more people than just your company.
    """
    private static let tweet4 = """
    Hard to ignore the shift here. Most CEOs wait until the numbers turn ugly to cut this deep, but using AI as the primary reason for a 40% reduction is a massive bet on a new type of lean execution. The next year will show if a "flatter" team actually moves faster or just breaks under the same load.
    """
    private static let bootsReview = """
    These boots are fantastic! They were purchased for my 14 year old son. He uses them in the snow, for paint balling, and for every day use. He says they are so comfortable that he would wear them all the time. They are light-weight and durable.
    """

    struct DetectionRunResult: Identifiable {
        let id = UUID()
        let caseName: String
        let text: String
        let expected: LocalInferenceService.DetectionVerdict?
        let result: LocalInferenceService.DetectionResult?   // nil on error
        let errorText: String?
    }

    struct Preset { let name: String; let system: String; let user: String }

    /// A variety of tasks spanning the capabilities that matter for on-device
    /// quality: factual knowledge, multi-step reasoning, the production filter
    /// task (unconstrained), and core NLP / generation / coding. All text-only
    /// — the QAT export has no vision encoder. Used both as quick-fill
    /// templates and as the "Run full test set" battery.
    static let presets: [Preset] = [
        Preset(
            name: "Knowledge",
            system: "You are a helpful assistant. Answer concisely.",
            user: "Name three planets in our solar system and one fact about each."),
        Preset(
            name: "Math reasoning",
            system: "You are a helpful assistant.",
            user: "If a train travels 60 miles in 1.5 hours, what is its average speed? Show your work."),
        Preset(
            name: "Common sense",
            system: "You are a helpful assistant.",
            user: "A cup of hot coffee is left on a table in a cold room for an hour. "
                + "Will it be hotter, colder, or the same temperature as when it was poured? "
                + "Answer in one sentence and explain briefly."),
        Preset(
            name: "Filter (unconstrained)",
            system: "You are a content filter. For each topic, answer 'yes' if the "
                + "post matches the topic and 'no' otherwise. Topics: crypto. "
                + "Respond with a single pipe-delimited row of yes/no.",
            user: "Just aped into a new memecoin, this one is going straight to the moon 🚀"),
        Preset(
            name: "Summarization",
            system: "You are a helpful assistant. Summarize text faithfully and concisely.",
            user: "Summarize the following in one sentence: The James Webb Space Telescope, "
                + "launched in December 2021, observes the universe primarily in infrared "
                + "light. Its large segmented mirror and sunshield let it detect faint, "
                + "distant objects, including some of the earliest galaxies that formed "
                + "after the Big Bang."),
        Preset(
            name: "Instruction following",
            system: "You are a helpful assistant. Follow formatting instructions exactly.",
            user: "List exactly three tips for staying focused while working from home. "
                + "Number them 1 to 3, one short sentence each, with no preamble or extra text."),
        Preset(
            name: "Sentiment",
            system: "You are a sentiment classifier.",
            user: "Classify the sentiment of this review as Positive, Negative, or Neutral, "
                + "then explain in one sentence: \"The battery lasts all day, but the camera "
                + "is disappointing in low light.\""),
        Preset(
            name: "Extraction (JSON)",
            system: "You extract structured data from text and reply with JSON only.",
            user: "Extract the person's name, company, and role as JSON: \"Maria Chen recently "
                + "joined Aurora Robotics as their new Head of Engineering.\""),
        Preset(
            name: "Translation",
            system: "You are a translation assistant.",
            user: "Translate this sentence into both Spanish and French: "
                + "\"Where is the nearest train station?\""),
        Preset(
            name: "Coding",
            system: "You are an expert programmer. Provide correct, minimal code.",
            user: "Write a Python function that returns the nth Fibonacci number iteratively. "
                + "Include a one-line docstring."),
    ]

    private var downloadedModels: [LocalInferenceService.LocalModel] {
        LocalInferenceService.models.filter { service.isDownloaded($0) }
    }

    var body: some View {
        NavigationStack {
            Form {
                modelSection
                promptSection
                runSection
                if !results.isEmpty { resultsSection }
                detectionSection
                if !detectionResults.isEmpty { detectionResultsSection }
            }
            .navigationTitle("Model Debug")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if !results.isEmpty || !detectionResults.isEmpty {
                        Button("Clear") {
                            results.removeAll()
                            detectionResults.removeAll()
                        }
                        .disabled(isRunning || isDetecting)
                    }
                }
            }
        }
    }

    // MARK: Model picker

    @ViewBuilder
    private var modelSection: some View {
        Section {
            if downloadedModels.isEmpty {
                Text("No models downloaded. Download a variant from the AI settings first.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(downloadedModels) { model in
                    Button {
                        service.selectModel(model)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(model.displayName)
                                    .foregroundStyle(.primary)
                                Text(model.approxSize)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if model.id == service.selectedModelID {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(.tint)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(isRunning)
                }
            }
        } header: {
            Text("Model")
        } footer: {
            Text("Tap to make a model active. Running here switches the app's active model.")
        }
    }

    // MARK: Prompt editor

    @ViewBuilder
    private var promptSection: some View {
        Section {
            Menu {
                ForEach(Self.presets.indices, id: \.self) { idx in
                    Button(Self.presets[idx].name) {
                        systemPrompt = Self.presets[idx].system
                        userPrompt = Self.presets[idx].user
                    }
                }
            } label: {
                Label("Load preset", systemImage: "text.badge.plus")
            }
            .disabled(isRunning)

            VStack(alignment: .leading, spacing: 4) {
                Text("System").font(.caption).foregroundStyle(.secondary)
                TextEditor(text: $systemPrompt)
                    .frame(minHeight: 70)
                    .font(.system(.footnote, design: .monospaced))
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("User").font(.caption).foregroundStyle(.secondary)
                TextEditor(text: $userPrompt)
                    .frame(minHeight: 70)
                    .font(.system(.footnote, design: .monospaced))
            }
            Stepper(value: $maxTokens, in: 16...1024, step: 32) {
                Text("Max output tokens: \(maxTokens)")
            }
            .disabled(isRunning)
        } header: {
            Text("Prompt")
        }
    }

    // MARK: Run controls

    private var activeModel: LocalInferenceService.LocalModel? {
        downloadedModels.first(where: { $0.id == service.selectedModelID }) ?? downloadedModels.first
    }

    // The current editable prompt, wrapped so it flows through the same runner
    // as the preset battery.
    private var customPrompt: Preset {
        Preset(name: "Custom", system: systemPrompt, user: userPrompt)
    }

    @ViewBuilder
    private var runSection: some View {
        Section {
            Button {
                if let active = activeModel { run(prompts: [customPrompt], models: [active]) }
            } label: {
                Label("Run prompt on active model", systemImage: "play.fill")
            }
            .disabled(isRunning || downloadedModels.isEmpty)

            Button {
                run(prompts: [customPrompt], models: downloadedModels)
            } label: {
                Label("Run prompt on all downloaded (\(downloadedModels.count))", systemImage: "play.circle.fill")
            }
            .disabled(isRunning || downloadedModels.isEmpty)

            Button {
                if let active = activeModel { run(prompts: Self.presets, models: [active]) }
            } label: {
                Label("Run full test set on active (\(Self.presets.count) tasks)", systemImage: "list.bullet.rectangle")
            }
            .disabled(isRunning || downloadedModels.isEmpty)

            if isRunning {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(runLabel).font(.footnote).foregroundStyle(.secondary)
                }
            }
        } footer: {
            Text("“Run prompt” uses the editor above. “Run full test set” runs all "
                + "\(Self.presets.count) preset tasks on the active model for a quality sweep.")
        }
    }

    // MARK: Results

    @ViewBuilder
    private var resultsSection: some View {
        Section("Results") {
            ForEach(results) { result in
                resultCard(result)
            }
        }
    }

    @ViewBuilder
    private func resultCard(_ result: RunResult) -> some View {
        let s = result.stats
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(result.taskName)
                        .font(.subheadline.weight(.semibold))
                    Text(s.modelDisplayName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if !result.isError {
                    Text(String(format: "%.2fs", s.wallSec))
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }

            Text(s.output)
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(result.isError ? .red : .primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 8))

            if !result.isError {
                VStack(alignment: .leading, spacing: 2) {
                    statRow("ttft", String(format: "%.0f ms", s.ttftMs))
                    statRow("prefill", String(format: "%d tok @ %.0f tok/s", s.prefillTokens, s.prefillTokPerSec))
                    statRow("decode", String(format: "%d tok @ %.0f tok/s", s.decodeTokens, s.decodeTokPerSec))
                    statRow("load / create / infer",
                            String(format: "%.2f / %.2f / %.2f s", s.loadSec, s.createSec, s.inferSec))
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func statRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.caption.monospacedDigit())
        }
    }

    // MARK: Run

    // Runs every (model, prompt) pair. The model is the outer loop so its
    // engine loads once and is reused across all prompts before switching.
    private func run(prompts: [Preset], models: [LocalInferenceService.LocalModel]) {
        guard !prompts.isEmpty, !models.isEmpty, !isRunning else { return }
        let maxT = maxTokens
        isRunning = true
        Task {
            for model in models {
                service.selectModel(model)
                for prompt in prompts {
                    runLabel = "\(model.displayName): \(prompt.name)…"
                    do {
                        let stats = try await service.debugRun(
                            systemMessage: prompt.system, userMessage: prompt.user,
                            maxOutputTokens: maxT)
                        results.insert(
                            RunResult(taskName: prompt.name, stats: stats, isError: false), at: 0)
                    } catch {
                        let errStats = LocalInferenceService.InferenceStats(
                            modelDisplayName: model.displayName,
                            output: "⚠️ \(error.localizedDescription)",
                            loadSec: 0, createSec: 0, inferSec: 0, wallSec: 0,
                            ttftMs: 0, prefillTokens: 0, prefillTokPerSec: 0,
                            decodeTokens: 0, decodeTokPerSec: 0)
                        results.insert(
                            RunResult(taskName: prompt.name, stats: errStats, isError: true), at: 0)
                    }
                }
            }
            runLabel = ""
            isRunning = false
        }
    }

    // MARK: AI-text detection

    @ViewBuilder
    private var detectionSection: some View {
        Section {
            if !service.detectorFilesPresent() {
                if let model = service.detectionModel {
                    Text("“\(model.displayName)” selected but its files aren’t fully "
                        + "downloaded (model + adapter).")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button {
                        service.startDownload(model)
                    } label: {
                        Label("Download model + adapter (\(model.approxSize))",
                              systemImage: "arrow.down.circle")
                    }
                    .disabled(isDetecting)
                } else {
                    Text("Detection needs a detection-capable model. Select the "
                        + "detector model in the AI-providers settings, then return here.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Text to classify").font(.caption).foregroundStyle(.secondary)
                    TextEditor(text: $detectionText)
                        .frame(minHeight: 70)
                        .font(.system(.footnote, design: .monospaced))
                }
                Button {
                    runDetection(cases: [DetectionCase(
                        name: "Custom", text: detectionText, expected: nil)])
                } label: {
                    Label("Detect this text", systemImage: "sparkle.magnifyingglass")
                }
                .disabled(isDetecting)
                Button {
                    runDetection(cases: Self.detectionCases)
                } label: {
                    Label("Run detection test set (\(Self.detectionCases.count))",
                          systemImage: "checklist")
                }
                .disabled(isDetecting)
                if isDetecting {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text(detectionLabel).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
        } header: {
            Text("AI-text detection")
        } footer: {
            Text("On-device detector — scoped LoRA + `activations` + classifier head. "
                + "Score ∈ [0,1]; thresholds: ≥0.16 AI-edited, ≥0.96 AI-generated.")
        }
    }

    @ViewBuilder
    private var detectionResultsSection: some View {
        Section("Detection results") {
            ForEach(detectionResults) { r in
                detectionCard(r)
            }
        }
    }

    @ViewBuilder
    private func detectionCard(_ r: DetectionRunResult) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(r.caseName).font(.subheadline.weight(.semibold))
                Spacer()
                if let res = r.result {
                    Text(String(format: "%.2fs", res.wallSec))
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            // The text under test — selectable so long samples can be copied.
            Text(r.text)
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            if let res = r.result {
                HStack(spacing: 6) {
                    Text(res.verdict.rawValue)
                        .font(.subheadline.weight(.bold))
                    Text(String(format: "score %.3f", res.score))
                        .font(.subheadline.monospacedDigit())
                    Spacer()
                    // ✓/✗ only for labeled cases; unlabeled samples show score only.
                    if let expected = r.expected {
                        Image(systemName: res.verdict == expected
                              ? "checkmark.circle.fill" : "xmark.circle.fill")
                            .foregroundStyle(res.verdict == expected ? .green : .red)
                    }
                }
                Text("probs: " + res.probs.map { String(format: "%.3f", $0) }.joined(separator: ", "))
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                Text(String(format: "load %.2fs · infer %.2fs · head %.1fms",
                            res.loadSec, res.inferSec, res.headSec * 1000))
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text(r.errorText ?? "error")
                    .font(.footnote).foregroundStyle(.red)
            }
        }
        .padding(.vertical, 2)
    }

    private func runDetection(cases: [DetectionCase]) {
        guard !cases.isEmpty, !isDetecting else { return }
        isDetecting = true
        Task {
            for c in cases {
                detectionLabel = "Detecting: \(c.name)…"
                do {
                    let res = try await service.detectAIText(c.text)
                    detectionResults.insert(
                        DetectionRunResult(caseName: c.name, text: c.text, expected: c.expected,
                                           result: res, errorText: nil), at: 0)
                } catch {
                    detectionResults.insert(
                        DetectionRunResult(caseName: c.name, text: c.text, expected: c.expected,
                                           result: nil,
                                           errorText: "⚠️ \(error.localizedDescription)"), at: 0)
                }
            }
            detectionLabel = ""
            isDetecting = false
        }
    }
}
#endif
