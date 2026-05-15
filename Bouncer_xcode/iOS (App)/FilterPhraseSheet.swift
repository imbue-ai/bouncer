//
//  FilterPhraseSheet.swift
//  iOS (App)
//
//  Native bottom sheet for managing filter phrases.
//

import SwiftUI
import WebKit
import TipKit
internal import Combine

// MARK: - Bouncer Tip

struct BouncerButtonTip: Tip {
    static let loggedIn = Tips.Event(id: "loggedInToTwitter")

    var title: Text { Text("Set up your filters") }
    var message: Text? { Text("Tap here to choose topics you want to filter from your feed.") }

    var options: [TipOption] {
        [Tips.MaxDisplayCount(1)]
    }

    var rules: [Tips.Rule] {
        [#Rule(Self.loggedIn) { $0.donations.count >= 1 }]
    }
}

// MARK: - ViewModel

class FilterSheetViewModel: ObservableObject {
    @Published var isPresented = false
    @Published var phrases: [String] = []
    @Published var themeMode: String = "dark"  // kept for JS bridge communication
    @Published var filteredCount: Int = 0
    @Published var canGoBack = false
    @Published var canGoForward = false
    @Published var currentURL: String = ""
    @Published var isEditingURL = false
    @Published var isFilteredModalOpen = false
    @Published var aiTextFilterEnabled: Bool = false
    @Published var aiTextDetectionThreshold: Double = 0.7

    weak var webView: WKWebView?

    static let contentWorld = WKContentWorld.world(name: "feedfilter")

    func addPhrase(_ text: String) {
        guard let webView = webView else { return }
        Task {
            try? await webView.callAsyncJavaScript(
                "return await window.__ff_addPhrase(text)",
                arguments: ["text": text],
                in: nil,
                contentWorld: Self.contentWorld
            )
        }
    }

    func removePhrase(_ phrase: String) {
        withAnimation {
            phrases.removeAll { $0 == phrase }
        }
        guard let webView = webView else { return }
        Task {
            try? await webView.callAsyncJavaScript(
                "return await window.__ff_removePhrase(phrase)",
                arguments: ["phrase": phrase],
                in: nil,
                contentWorld: Self.contentWorld
            )
        }
    }

    func setPanelOpen(_ open: Bool) {
        guard let webView = webView else { return }
        Task {
            try? await webView.callAsyncJavaScript(
                "document.body.classList.toggle('ff-panel-open', open)",
                arguments: ["open": open],
                in: nil,
                contentWorld: Self.contentWorld
            )
        }
    }

    func goBack() {
        webView?.goBack()
    }

    func goForward() {
        webView?.goForward()
    }

    func reload() {
        webView?.reload()
    }

    func navigateTo(urlString: String) {
        var input = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if !input.contains("://") {
            input = "https://" + input
        }
        guard let url = URL(string: input) else { return }
        webView?.load(URLRequest(url: url))
    }

    func loadAiTextFilterEnabled() {
        guard let webView = webView else { return }
        Task { @MainActor in
            do {
                let result = try await webView.callAsyncJavaScript(
                    "return await window.__ff_getAiTextFilterEnabled()",
                    arguments: [:],
                    in: nil,
                    contentWorld: Self.contentWorld
                )
                if let value = result as? Bool {
                    self.aiTextFilterEnabled = value
                }
            } catch {
                print("[FeedFilter] loadAiTextFilterEnabled error: \(error)")
            }
        }
    }

    func setAiTextFilterEnabled(_ enabled: Bool) {
        aiTextFilterEnabled = enabled
        guard let webView = webView else { return }
        Task {
            try? await webView.callAsyncJavaScript(
                "return await window.__ff_setAiTextFilterEnabled(enabled)",
                arguments: ["enabled": enabled],
                in: nil,
                contentWorld: Self.contentWorld
            )
        }
    }

    func loadAiTextDetectionThreshold() {
        guard let webView = webView else { return }
        Task { @MainActor in
            do {
                let result = try await webView.callAsyncJavaScript(
                    "return await window.__ff_getAiTextDetectionThreshold()",
                    arguments: [:],
                    in: nil,
                    contentWorld: Self.contentWorld
                )
                if let value = result as? Double {
                    self.aiTextDetectionThreshold = value
                } else if let value = result as? NSNumber {
                    self.aiTextDetectionThreshold = value.doubleValue
                }
            } catch {
                print("[FeedFilter] loadAiTextDetectionThreshold error: \(error)")
            }
        }
    }

    func setAiTextDetectionThreshold(_ value: Double) {
        let clamped = min(1.0, max(0.0, value))
        aiTextDetectionThreshold = clamped
        guard let webView = webView else { return }
        Task {
            try? await webView.callAsyncJavaScript(
                "return await window.__ff_setAiTextDetectionThreshold(value)",
                arguments: ["value": clamped],
                in: nil,
                contentWorld: Self.contentWorld
            )
        }
    }

    // Drive the same composer-paste flow the desktop "Share filters" button
    // uses. Native side dismisses the filter sheet (so the user can see the
    // composer) and ensures the WebView is on x.com — the JS side requires
    // it because the flow clicks <a href="/compose/post"> to open X's modal.
    // Once the JS bridge resolves, X's compose dialog is open with the
    // filter-pack screenshot + caption already pasted in; the user just hits
    // Post.
    func shareFilterPack() {
        guard let webView = webView else { return }
        isPresented = false
        Task { @MainActor in
            await ensureOnX(webView: webView)
            do {
                let result = try await webView.callAsyncJavaScript(
                    "return await window.__ff_shareFilterPack()",
                    arguments: [:],
                    in: nil,
                    contentWorld: Self.contentWorld
                )
                if let dict = result as? [String: Any], dict["ok"] as? Bool != true {
                    let err = (dict["error"] as? String) ?? "unknown"
                    print("[FeedFilter] shareFilterPack rejected: \(err)")
                }
            } catch {
                print("[FeedFilter] shareFilterPack error: \(error)")
            }
        }
    }

    // If the WebView isn't on an x.com page, send it to x.com/home and wait
    // for the load to settle before invoking the JS share bridge — content.js
    // re-injects on each navigation, so we need it ready on the new URL.
    @MainActor
    private func ensureOnX(webView: WKWebView) async {
        let host = webView.url?.host?.lowercased() ?? ""
        let onX = host == "x.com" || host.hasSuffix(".x.com")
            || host == "twitter.com" || host.hasSuffix(".twitter.com")
        if onX { return }
        guard let target = URL(string: "https://x.com/home") else { return }
        webView.load(URLRequest(url: target))
        await waitForXLoad(webView: webView)
    }

    @MainActor
    private func waitForXLoad(webView: WKWebView) async {
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 200_000_000)
            let host = webView.url?.host?.lowercased() ?? ""
            let onX = host == "x.com" || host.hasSuffix(".x.com")
                || host == "twitter.com" || host.hasSuffix(".twitter.com")
            if onX && !webView.isLoading { return }
        }
    }

    // Generic chrome.storage.local accessors used by the native providers
    // settings page. The JS bridge (__ff_getStorage / __ff_setStorage) is
    // only available once content.js has run, so the call site has to
    // ensure the WebView is on x.com first.
    @MainActor
    func getStorage(keys: [String]) async -> [String: Any] {
        guard let webView = webView else { return [:] }
        await ensureOnX(webView: webView)
        do {
            let result = try await webView.callAsyncJavaScript(
                "return await window.__ff_getStorage(keys)",
                arguments: ["keys": keys],
                in: nil,
                contentWorld: Self.contentWorld
            )
            return (result as? [String: Any]) ?? [:]
        } catch {
            print("[FeedFilter] getStorage error: \(error)")
            return [:]
        }
    }

    @MainActor
    func setStorage(_ items: [String: Any]) async {
        guard let webView = webView else { return }
        await ensureOnX(webView: webView)
        do {
            let _ = try await webView.callAsyncJavaScript(
                "return await window.__ff_setStorage(items)",
                arguments: ["items": items],
                in: nil,
                contentWorld: Self.contentWorld
            )
        } catch {
            print("[FeedFilter] setStorage error: \(error)")
        }
    }

    @MainActor
    func clearModelCache() async {
        guard let webView = webView else { return }
        do {
            let _ = try await webView.callAsyncJavaScript(
                "return await window.__ff_clearModelCache()",
                arguments: [:],
                in: nil,
                contentWorld: Self.contentWorld
            )
        } catch {
            print("[FeedFilter] clearModelCache error: \(error)")
        }
    }

    func openFilteredModal() {
        guard let webView = webView else {
            print("[FeedFilter] openFilteredModal: no webView")
            return
        }
        Task { @MainActor in
            do {
                isFilteredModalOpen = true
                let _ = try await webView.callAsyncJavaScript(
                    """
                    window.__ff_showFilteredModal();
                    // Watch for modal close and notify native
                    const observer = new MutationObserver(() => {
                        if (!document.querySelector('.ff-ios-filtered-modal-backdrop')) {
                            observer.disconnect();
                            webkit.messageHandlers.feedfilterModalClosed.postMessage({});
                        }
                    });
                    observer.observe(document.body, { childList: true, subtree: true });
                    return true;
                    """,
                    arguments: [:],
                    in: nil,
                    contentWorld: Self.contentWorld
                )
            } catch {
                print("[FeedFilter] openFilteredModal error: \(error)")
                isFilteredModalOpen = false
            }
        }
    }
}

// MARK: - Non-dismissing TextField

#if os(iOS)
struct PersistentKeyboardTextField: UIViewRepresentable {
    @Binding var text: String
    var placeholder: String
    var onSubmit: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> UITextField {
        let tf = UITextField()
        tf.delegate = context.coordinator
        tf.font = .systemFont(ofSize: 16)
        tf.textColor = .label
        tf.attributedPlaceholder = NSAttributedString(
            string: placeholder,
            attributes: [.foregroundColor: UIColor.secondaryLabel]
        )
        tf.returnKeyType = .send
        tf.setContentHuggingPriority(.defaultLow, for: .horizontal)
        tf.addTarget(context.coordinator, action: #selector(Coordinator.textChanged(_:)), for: .editingChanged)
        return tf
    }

    func updateUIView(_ uiView: UITextField, context: Context) {
        if uiView.text != text {
            uiView.text = text
        }
    }

    class Coordinator: NSObject, UITextFieldDelegate {
        var parent: PersistentKeyboardTextField

        init(_ parent: PersistentKeyboardTextField) {
            self.parent = parent
        }

        @objc func textChanged(_ textField: UITextField) {
            parent.text = textField.text ?? ""
        }

        func textFieldShouldReturn(_ textField: UITextField) -> Bool {
            parent.onSubmit()
            // Return false to prevent the keyboard from dismissing
            return false
        }
    }
}
struct URLBarTextField: UIViewRepresentable {
    @Binding var text: String
    var placeholder: String
    var onSubmit: () -> Void
    var onBeginEditing: (() -> Void)?
    var onEndEditing: (() -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> UITextField {
        let tf = UITextField()
        tf.delegate = context.coordinator
        tf.font = .systemFont(ofSize: 16)
        tf.textColor = .label
        tf.attributedPlaceholder = NSAttributedString(
            string: placeholder,
            attributes: [.foregroundColor: UIColor.secondaryLabel]
        )
        tf.returnKeyType = .go
        tf.keyboardType = .URL
        tf.autocapitalizationType = .none
        tf.autocorrectionType = .no
        tf.clearButtonMode = .whileEditing
        tf.setContentHuggingPriority(.defaultLow, for: .horizontal)
        tf.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        tf.translatesAutoresizingMaskIntoConstraints = false
        tf.addTarget(context.coordinator, action: #selector(Coordinator.textChanged(_:)), for: .editingChanged)
        return tf
    }

    func updateUIView(_ uiView: UITextField, context: Context) {
        if uiView.text != text {
            uiView.text = text
        }
    }

    class Coordinator: NSObject, UITextFieldDelegate {
        var parent: URLBarTextField

        init(_ parent: URLBarTextField) {
            self.parent = parent
        }

        @objc func textChanged(_ textField: UITextField) {
            parent.text = textField.text ?? ""
        }

        func textFieldDidBeginEditing(_ textField: UITextField) {
            parent.onBeginEditing?()
        }

        func textFieldDidEndEditing(_ textField: UITextField) {
            parent.onEndEditing?()
        }

        func textFieldShouldReturn(_ textField: UITextField) -> Bool {
            parent.onSubmit()
            textField.resignFirstResponder()
            return true
        }
    }
}
#endif

// MARK: - Sheet View

struct FilterPhraseSheet: View {
    @ObservedObject var viewModel: FilterSheetViewModel
    @State private var newPhrase = ""

    var body: some View {
        NavigationStack {
            List {
                if viewModel.phrases.isEmpty {
                    Text("No topics added yet.")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 30)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                } else {
                    ForEach(viewModel.phrases.reversed(), id: \.self) { phrase in
                        HStack {
                            Text(phrase)
                                .font(.system(size: 19, weight: .regular))
                                .foregroundStyle(.primary)
                                .padding(.leading, 8)
                            Spacer()
                            Button {
                                viewModel.removePhrase(phrase)
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 20))
                                    .foregroundStyle(.tertiary)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.vertical, 8)
                        .listRowBackground(Color.clear)
                    }
                    .onDelete { offsets in
                        let reversed = viewModel.phrases.reversed()
                        for index in offsets {
                            let phrase = Array(reversed)[index]
                            viewModel.removePhrase(phrase)
                        }
                    }
                }
            }
            .listStyle(.plain)
            .padding(.bottom, 1)
            .onTapGesture {
                UIApplication.shared.sendAction(
                    #selector(UIResponder.resignFirstResponder),
                    to: nil, from: nil, for: nil
                )
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 12) {
                    HStack(spacing: 0) {
                        PersistentKeyboardTextField(
                            text: $newPhrase,
                            placeholder: "Add a topic to filter...",
                            onSubmit: { submitPhrase() }
                        )
                        .frame(height: 20)

                        Button {
                            submitPhrase()
                        } label: {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.system(size: 28))
                                .symbolRenderingMode(.hierarchical)
                                .foregroundStyle(.tint)
                        }
                        .buttonStyle(.plain)
                        .disabled(newPhrase.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    .padding(.leading, 14)
                    .padding(.trailing, 6)
                    .padding(.vertical, 6)
                    .background(Color(.tertiarySystemFill))
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))

                    Button {
                        viewModel.isPresented = false
                        viewModel.openFilteredModal()
                    } label: {
                        Text("View filtered posts (\(viewModel.filteredCount))")
                    }
                    .buttonStyle(.plain)
                    .controlSize(.small)
                    .foregroundStyle(.tint)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 8)
                .animation(.none, value: newPhrase)
                .transaction { $0.animation = nil }
        }
            .navigationTitle("Filter out")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        viewModel.shareFilterPack()
                    } label: {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 17, weight: .regular))
                    }
                    .accessibilityLabel("Share filters")
                    .disabled(viewModel.phrases.isEmpty)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        BouncerSettingsView(viewModel: viewModel)
                    } label: {
                        Image(systemName: "gearshape")
                            .font(.system(size: 17, weight: .regular))
                    }
                    .accessibilityLabel("Settings")
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .onAppear {
            viewModel.loadAiTextFilterEnabled()
        }
    }

    private func submitPhrase() {
        let text = newPhrase.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        viewModel.addPhrase(text)
        newPhrase = ""
    }
}

// MARK: - Settings View

struct BouncerSettingsView: View {
    @ObservedObject var viewModel: FilterSheetViewModel

    // Mirrors viewModel.aiTextDetectionThreshold during a drag so the slider
    // and percentage update smoothly without round-tripping through JS on
    // every frame. We only persist when the drag ends.
    @State private var draftThreshold: Double = 0.7
    @State private var isDragging: Bool = false

    private var displayThreshold: Double {
        isDragging ? draftThreshold : viewModel.aiTextDetectionThreshold
    }

    // AI text detection routes through the Imbue WebSocket gateway, which
    // requires Firebase App Check. On builds shipped without a
    // GoogleService-Info plist the feature is unusable, so hide the whole
    // section.
    private var hasImbueBackend: Bool {
        AppCheckBridge.shared.isAvailable
    }

    var body: some View {
        Form {
            Section {
                NavigationLink {
                    ProvidersSettingsView(viewModel: viewModel)
                } label: {
                    HStack {
                        Image(systemName: "key.fill")
                            .foregroundStyle(.tint)
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("AI providers")
                            if !hasImbueBackend {
                                Text("Required — add an API key to enable filtering")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            } header: {
                Text("Providers")
            } footer: {
                if !hasImbueBackend {
                    Text("This build has no bundled backend. Bring your own OpenAI, Anthropic, Gemini, or OpenRouter API key to classify posts.")
                }
            }

            if hasImbueBackend {
                Section {
                    Toggle(isOn: Binding(
                        get: { viewModel.aiTextFilterEnabled },
                        set: { viewModel.setAiTextFilterEnabled($0) }
                    )) {
                        Text("Filter AI-generated text")
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Confidence threshold")
                            Spacer()
                            Text("\(Int(round(displayThreshold * 100)))%")
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                        Slider(
                            value: Binding(
                                get: { displayThreshold },
                                set: { draftThreshold = $0 }
                            ),
                            in: 0...1
                        ) {
                            Text("Confidence threshold")
                        } minimumValueLabel: {
                            Text("0%").font(.caption2).foregroundStyle(.secondary)
                        } maximumValueLabel: {
                            Text("100%").font(.caption2).foregroundStyle(.secondary)
                        } onEditingChanged: { editing in
                            if editing {
                                draftThreshold = viewModel.aiTextDetectionThreshold
                                isDragging = true
                            } else {
                                isDragging = false
                                viewModel.setAiTextDetectionThreshold(draftThreshold)
                            }
                        }
                    }
                    .padding(.vertical, 4)
                    .disabled(!viewModel.aiTextFilterEnabled)
                    .opacity(viewModel.aiTextFilterEnabled ? 1.0 : 0.5)
                } header: {
                    Text("AI Text Detection")
                } footer: {
                    Text("Hide posts whose text appears to be written by AI. Posts at or above this confidence are hidden.")
                }
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if hasImbueBackend {
                viewModel.loadAiTextFilterEnabled()
                viewModel.loadAiTextDetectionThreshold()
            }
        }
    }
}

// MARK: - Providers Settings

private struct ProviderSpec: Identifiable {
    let id: String              // "openai", "anthropic", ...
    let displayName: String
    let storageKey: String      // chrome.storage.local key
    let placeholder: String
    let helpURL: String?
    let models: [ProviderModel]
}

private struct ProviderModel {
    let id: String              // model name as stored
    let display: String
}

// Mirrors PREDEFINED_MODELS from Bouncer/src/shared/models.ts. Kept in sync
// manually — the desktop list is the source of truth.
private let providerSpecs: [ProviderSpec] = [
    ProviderSpec(
        id: "openai",
        displayName: "OpenAI",
        storageKey: "openaiApiKey",
        placeholder: "sk-...",
        helpURL: "https://platform.openai.com/api-keys",
        models: [
            ProviderModel(id: "gpt-5-nano", display: "GPT-5 Nano"),
        ]
    ),
    ProviderSpec(
        id: "anthropic",
        displayName: "Anthropic",
        storageKey: "anthropicApiKey",
        placeholder: "sk-ant-...",
        helpURL: "https://console.anthropic.com/settings/keys",
        models: [
            ProviderModel(id: "claude-haiku-4-5-20251001", display: "Claude Haiku 4.5"),
        ]
    ),
    ProviderSpec(
        id: "gemini",
        displayName: "Gemini",
        storageKey: "geminiApiKey",
        placeholder: "AIza...",
        helpURL: "https://aistudio.google.com/apikey",
        models: [
            ProviderModel(id: "gemini-2.5-flash-lite", display: "Gemini 2.5 Flash Lite"),
            ProviderModel(id: "gemini-2.5-flash", display: "Gemini 2.5 Flash"),
            ProviderModel(id: "gemini-3-flash-preview", display: "Gemini 3 Flash"),
            ProviderModel(id: "gemini-3.1-flash-lite-preview", display: "Gemini 3.1 Flash Lite"),
        ]
    ),
    ProviderSpec(
        id: "openrouter",
        displayName: "OpenRouter",
        storageKey: "openrouterApiKey",
        placeholder: "sk-or-...",
        helpURL: "https://openrouter.ai/settings/keys",
        models: [
            ProviderModel(id: "nvidia/nemotron-nano-12b-v2-vl:free", display: "Nemotron Nano 12B VL (free)"),
            ProviderModel(id: "mistralai/ministral-3b-2512", display: "Ministral 3B"),
        ]
    ),
]

// The Imbue backend ships its own bundled model selection — picking it
// from the popup writes the literal string "imbue" to selectedModel
// (no "provider:model" prefix like BYOK entries). Keep the sentinel in
// one place so the comparison in selectModel/active-row logic doesn't
// drift.
private let imbueModelKey = "imbue"

struct ProvidersSettingsView: View {
    @ObservedObject var viewModel: FilterSheetViewModel

    // provider id -> current key text in the field
    @State private var keys: [String: String] = [:]
    // provider id -> on-disk key (used to detect dirty state)
    @State private var storedKeys: [String: String] = [:]
    // "<provider>:<modelName>" selected for filtering, or "" if none.
    // For Imbue, just the literal "imbue".
    @State private var selectedModel: String = ""
    @State private var isLoaded = false

    private var hasImbueBackend: Bool {
        AppCheckBridge.shared.isAvailable
    }

    var body: some View {
        Form {
            Section {
                if selectedModel.isEmpty {
                    Text("No model selected")
                        .foregroundStyle(.secondary)
                } else {
                    HStack {
                        Text(currentModelLabel)
                        Spacer()
                        Text(currentProviderLabel)
                            .foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text("Active model")
            } footer: {
                Text("The selected model is used to classify posts in your feed.")
            }

            if hasImbueBackend {
                imbueSection
            }

            ForEach(providerSpecs) { spec in
                providerSection(spec)
            }
        }
        .navigationTitle("AI providers")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await loadAll()
        }
    }

    private var currentProviderLabel: String {
        if selectedModel == imbueModelKey { return "Imbue" }
        guard let colon = selectedModel.firstIndex(of: ":") else { return "" }
        let providerId = String(selectedModel[..<colon])
        return providerSpecs.first(where: { $0.id == providerId })?.displayName ?? providerId
    }

    private var currentModelLabel: String {
        if selectedModel == imbueModelKey { return "Imbue (default)" }
        guard let colon = selectedModel.firstIndex(of: ":") else { return selectedModel }
        let providerId = String(selectedModel[..<colon])
        let modelId = String(selectedModel[selectedModel.index(after: colon)...])
        let spec = providerSpecs.first(where: { $0.id == providerId })
        return spec?.models.first(where: { $0.id == modelId })?.display ?? modelId
    }

    @ViewBuilder
    private var imbueSection: some View {
        Section {
            Button {
                Task { await selectModel(imbueModelKey) }
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Imbue (default)")
                            .foregroundStyle(.primary)
                        Text("Use Bouncer's bundled hosted model. No API key required.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if selectedModel == imbueModelKey {
                        Image(systemName: "checkmark")
                            .foregroundStyle(.tint)
                    }
                }
            }
            .buttonStyle(.plain)
        } header: {
            Text("Imbue")
        }
    }

    @ViewBuilder
    private func providerSection(_ spec: ProviderSpec) -> some View {
        let hasKey = !(storedKeys[spec.id] ?? "").isEmpty
        let draft = keys[spec.id] ?? ""
        let isDirty = draft != (storedKeys[spec.id] ?? "")

        Section {
            HStack {
                SecureField(spec.placeholder, text: Binding(
                    get: { keys[spec.id] ?? "" },
                    set: { keys[spec.id] = $0 }
                ))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .submitLabel(.done)

                if hasKey && !isDirty {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                }
            }

            if isDirty {
                Button(draft.isEmpty ? "Remove key" : "Save key") {
                    Task { await saveKey(spec) }
                }
                .disabled(!isLoaded)
            }

            ForEach(spec.models, id: \.id) { model in
                let modelKey = "\(spec.id):\(model.id)"
                Button {
                    Task { await selectModel(modelKey) }
                } label: {
                    HStack {
                        Text(model.display)
                            .foregroundStyle(.primary)
                        Spacer()
                        if selectedModel == modelKey {
                            Image(systemName: "checkmark")
                                .foregroundStyle(.tint)
                        }
                    }
                }
                .buttonStyle(.plain)
                .disabled(!hasKey || isDirty)
                .opacity((!hasKey || isDirty) ? 0.5 : 1.0)
            }

            if let urlString = spec.helpURL, let url = URL(string: urlString) {
                Link(destination: url) {
                    HStack(spacing: 4) {
                        Text("Get an API key")
                        Image(systemName: "arrow.up.right")
                            .font(.caption)
                    }
                    .font(.footnote)
                }
            }
        } header: {
            Text(spec.displayName)
        }
    }

    @MainActor
    private func loadAll() async {
        let storageKeys = providerSpecs.map(\.storageKey) + ["selectedModel"]
        let data = await viewModel.getStorage(keys: storageKeys)

        var loadedKeys: [String: String] = [:]
        for spec in providerSpecs {
            loadedKeys[spec.id] = (data[spec.storageKey] as? String) ?? ""
        }
        self.keys = loadedKeys
        self.storedKeys = loadedKeys

        // On a fresh install chrome.storage.local has no `selectedModel`
        // entry yet. The JS pipeline still classifies posts because
        // `DEFAULT_MODEL` in shared/models.ts falls back to "imbue" on
        // Imbue-enabled builds — but the native UI was showing
        // "No model selected" because we only mirrored the stored value.
        // Reflect the JS default so the providers page matches reality.
        let stored = (data["selectedModel"] as? String) ?? ""
        if stored.isEmpty, hasImbueBackend {
            self.selectedModel = imbueModelKey
        } else {
            self.selectedModel = stored
        }
        self.isLoaded = true
    }

    @MainActor
    private func saveKey(_ spec: ProviderSpec) async {
        let value = keys[spec.id] ?? ""
        await viewModel.setStorage([spec.storageKey: value])
        storedKeys[spec.id] = value

        // If we just removed the key for the currently active provider,
        // fall back to Imbue (when available) so filtering doesn't silently
        // break; otherwise clear the selection.
        if value.isEmpty, selectedModel.hasPrefix("\(spec.id):") {
            let fallback = hasImbueBackend ? imbueModelKey : ""
            await viewModel.setStorage(["selectedModel": fallback])
            selectedModel = fallback
        }
        await viewModel.clearModelCache()
    }

    @MainActor
    private func selectModel(_ modelKey: String) async {
        await viewModel.setStorage(["selectedModel": modelKey])
        selectedModel = modelKey
        await viewModel.clearModelCache()
    }
}

// MARK: - Container View

struct FilteredWebViewContainer: View {
    @StateObject var viewModel = FilterSheetViewModel()
    @State private var isOnboarded = UserDefaults.standard.bool(forKey: "hasCompletedOnboarding")
    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                ZStack {
                    if isOnboarded {
                        FilteredWebView(sheetViewModel: viewModel)
                    }

                    if viewModel.isEditingURL {
                        Color.clear
                            .contentShape(Rectangle())
                            .ignoresSafeArea(edges: .top)
                            .transition(.opacity)
                            .onTapGesture {
                                UIApplication.shared.sendAction(
                                    #selector(UIResponder.resignFirstResponder),
                                    to: nil, from: nil, for: nil
                                )
                            }
                    }

                    if viewModel.isPresented {
                        Color.clear
                            .contentShape(Rectangle())
                            .ignoresSafeArea(edges: .top)
                            .onTapGesture {
                                viewModel.isPresented = false
                            }
                    }
                }
                .animation(.easeInOut(duration: 0.2), value: viewModel.isEditingURL)

                if !viewModel.isFilteredModalOpen {
                    NavBarView(viewModel: viewModel)
                }
            }
            .background(Color(.systemBackground))
            .sheet(isPresented: $viewModel.isPresented) {
                viewModel.setPanelOpen(false)
            } content: {
                FilterPhraseSheet(viewModel: viewModel)
                    .padding(.top, {
                        if #available(iOS 26.0, *) { return CGFloat(0) }
                        else { return CGFloat(16) }
                    }())
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
                    .presentationBackgroundInteraction(.enabled(upThrough: .medium))
                    .presentationBackground {
                        if #available(iOS 26.0, *) {
                            Color(.systemBackground).opacity(0.85)
                        } else {
                            Color(.systemBackground)
                        }
                    }
            }
            .onChange(of: viewModel.isPresented) { _, newValue in
                if newValue {
                    viewModel.setPanelOpen(true)
                }
            }

            // Onboarding overlays on top; fades + scales out on dismiss
            if !isOnboarded {
                OnboardingView(isOnboarded: $isOnboarded)
                    .transition(.asymmetric(
                        insertion: .opacity,
                        removal: .opacity.combined(with: .scale(scale: 1.05))
                    ))
            }
        }
        .animation(.easeOut(duration: 0.35), value: isOnboarded)
    }
}

// MARK: - Navigation Bar

struct NavBarView: View {
    @ObservedObject var viewModel: FilterSheetViewModel
    @State private var urlText: String = ""
    var bouncerTip = BouncerButtonTip()

    private var isEditing: Bool { viewModel.isEditingURL }

    var body: some View {
        VStack(spacing: 0) {
            Divider()

            // URL bar row
            HStack(spacing: 6) {
                if !isEditing {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 12, weight: .regular))
                        .foregroundStyle(.secondary)
                }

                URLBarTextField(
                    text: $urlText,
                    placeholder: "Search or enter address",
                    onSubmit: {
                        viewModel.navigateTo(urlString: urlText)
                        viewModel.isEditingURL = false
                        urlText = displayURL(viewModel.currentURL)
                    },
                    onBeginEditing: {
                        viewModel.isEditingURL = true
                        urlText = viewModel.currentURL
                    },
                    onEndEditing: {
                        viewModel.isEditingURL = false
                        urlText = displayURL(viewModel.currentURL)
                    }
                )
                .frame(height: 22)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Color(.tertiarySystemFill))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 4)

            // Toolbar row - matches Safari bottom toolbar layout
            HStack(spacing: 0) {
                // Back
                Button { viewModel.goBack() } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 20, weight: .regular))
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .disabled(!viewModel.canGoBack)
                .tint(viewModel.canGoBack ? .accentColor : Color(.quaternaryLabel))

                // Forward
                Button { viewModel.goForward() } label: {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 20, weight: .regular))
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .disabled(!viewModel.canGoForward)
                .tint(viewModel.canGoForward ? .accentColor : Color(.quaternaryLabel))

                // Share (placeholder - matches Safari layout)
                Button { viewModel.reload() } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 20, weight: .regular))
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .foregroundStyle(.tint)

                // Bouncer filter button
                Button {
                    bouncerTip.invalidate(reason: .actionPerformed)
                    viewModel.isPresented.toggle()
                } label: {
                    ZStack(alignment: .topTrailing) {
                        Image("BouncerBlack")
                            .resizable()
                            .renderingMode(.template)
                            .aspectRatio(contentMode: .fit)
                            .frame(width: 32, height: 32)
                            .foregroundStyle(.tint)

                        if viewModel.filteredCount > 0 {
                            Text("\(viewModel.filteredCount)")
                                .font(.system(size: 12, weight: .bold))
                                .foregroundColor(.white)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(Color.red)
                                .clipShape(Capsule())
                                .offset(x: 8, y: -8)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .contentShape(Rectangle())
                }
                .popoverTip(bouncerTip, arrowEdge: .bottom)
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 2)
        }
        .background(.bar)
        .onAppear {
            urlText = displayURL(viewModel.currentURL)
        }
        .onChange(of: viewModel.currentURL) { _, newURL in
            if !isEditing {
                urlText = displayURL(newURL)
            }
            if newURL.contains("x.com/home") || newURL.contains("twitter.com/home") {
                UserDefaults.standard.set(true, forKey: "hasLoggedIn")
                Task { await BouncerButtonTip.loggedIn.donate() }
//                 // Delay so the tip doesn't appear during auth redirects
//                 DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
//                     if viewModel.currentURL.contains("x.com/home") || viewModel.currentURL.contains("twitter.com/home") {
//                         Task { await BouncerButtonTip.loggedIn.donate() }
//                     }
//                 }
            }
        }
    }

    private func displayURL(_ urlString: String) -> String {
        guard let url = URL(string: urlString),
              let host = url.host else { return urlString }
        let path = url.path
        if path.isEmpty || path == "/" {
            return host
        }
        return host + path
    }
}

// MARK: - Bouncer Icon (matching the SVG used in the JS FAB)

struct BouncerIcon: View {
    var body: some View {
        Canvas { context, size in
            let sx = size.width / 166
            let sy = size.height / 166
            func x(_ v: CGFloat) -> CGFloat { (v - 17) * sx }
            func y(_ v: CGFloat) -> CGFloat { (v - 25) * sy }

            let leftFoot = Path(ellipseIn: CGRect(
                x: x(45) - 26 * sx, y: y(178) - 8 * sy,
                width: 52 * sx, height: 16 * sy
            ))
            context.fill(leftFoot, with: .color(.white))

            let leftBase = Path(roundedRect: CGRect(x: x(19), y: y(170), width: 52 * sx, height: 8 * sy), cornerRadius: 3 * min(sx, sy))
            context.fill(leftBase, with: .color(.white))

            let leftPole = Path(roundedRect: CGRect(x: x(38), y: y(48), width: 14 * sx, height: 122 * sy), cornerRadius: 3 * min(sx, sy))
            context.fill(leftPole, with: .color(.white))

            let leftHead = Path(ellipseIn: CGRect(x: x(45) - 13 * sx, y: y(43) - 13 * sy, width: 26 * sx, height: 26 * sy))
            context.fill(leftHead, with: .color(.white))

            let rightFoot = Path(ellipseIn: CGRect(
                x: x(155) - 26 * sx, y: y(178) - 8 * sy,
                width: 52 * sx, height: 16 * sy
            ))
            context.fill(rightFoot, with: .color(.white))

            let rightBase = Path(roundedRect: CGRect(x: x(129), y: y(170), width: 52 * sx, height: 8 * sy), cornerRadius: 3 * min(sx, sy))
            context.fill(rightBase, with: .color(.white))

            let rightPole = Path(roundedRect: CGRect(x: x(148), y: y(48), width: 14 * sx, height: 122 * sy), cornerRadius: 3 * min(sx, sy))
            context.fill(rightPole, with: .color(.white))

            let rightHead = Path(ellipseIn: CGRect(x: x(155) - 13 * sx, y: y(43) - 13 * sy, width: 26 * sx, height: 26 * sy))
            context.fill(rightHead, with: .color(.white))

            let leftNub = Path(roundedRect: CGRect(x: x(52), y: y(60), width: 8 * sx, height: 6 * sy), cornerRadius: 2 * min(sx, sy))
            context.fill(leftNub, with: .color(.white))

            let rightNub = Path(roundedRect: CGRect(x: x(140), y: y(60), width: 8 * sx, height: 6 * sy), cornerRadius: 2 * min(sx, sy))
            context.fill(rightNub, with: .color(.white))

            var rope = Path()
            rope.move(to: CGPoint(x: x(58), y: y(63)))
            rope.addQuadCurve(to: CGPoint(x: x(142), y: y(63)), control: CGPoint(x: x(100), y: y(128)))
            context.stroke(rope, with: .color(.white), style: StrokeStyle(lineWidth: 9 * min(sx, sy), lineCap: .round))

            let ropeLeft = Path(ellipseIn: CGRect(x: x(58) - 6 * sx, y: y(63) - 6 * sy, width: 12 * sx, height: 12 * sy))
            context.fill(ropeLeft, with: .color(.white))

            let ropeRight = Path(ellipseIn: CGRect(x: x(142) - 6 * sx, y: y(63) - 6 * sy, width: 12 * sx, height: 12 * sy))
            context.fill(ropeRight, with: .color(.white))
        }
    }
}
