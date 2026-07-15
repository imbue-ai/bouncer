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

// MARK: - WebView Cache

// Owns the per-platform WKWebView instances so a platform switch just flips
// visibility instead of navigating. First tap on a platform creates and
// registers its webview via WebViewFactory (which also kicks off the initial
// navigation); subsequent taps just call showPlatform to make it visible.
//
// Off-screen webviews are muted and have their media paused via a small JS
// injection. WKWebView doesn't expose a supported way to freeze JS timers
// in a hidden page, so background feed polling / MutationObservers keep
// running; that's an acceptable trade-off for v1 (see the multi-webview
// plan file).
@MainActor
final class WebViewCache: ObservableObject {
    // Ordered list of platforms the user has visited this session. Drives the
    // ForEach in FilteredWebViewContainer so newly-visited platforms slot into
    // the ZStack without disturbing existing webviews. Publish so SwiftUI
    // re-runs the ForEach when the first visit to a new platform happens.
    @Published private(set) var visitedPlatforms: [String] = []
    private var webViews: [String: WKWebView] = [:]

    // Single shared Coordinator across all cached webviews. Message handlers
    // already disambiguate senders via `message.webView`; navigation state
    // (canGoBack / URL) is tracked only for whichever webview is currently
    // active (see Coordinator.activate).
    let coordinator: FilteredWebView.WebCoordinator

    init(coordinator: FilteredWebView.WebCoordinator) {
        self.coordinator = coordinator
    }

    // Non-creating lookup. Used by the ViewModel's computed `webView` accessor
    // so incidental reads don't spawn webviews for platforms the user hasn't
    // visited. Pass create: true from `showPlatform` where creation is the
    // intent.
    func webView(for platform: String, create: Bool = false) -> WKWebView? {
        if let existing = webViews[platform] { return existing }
        guard create, let def = Platforms.byId(platform) else { return nil }
        let wv = FilteredWebView.WebViewFactory.make(platform: def, coordinator: coordinator)
        webViews[platform] = wv
        visitedPlatforms.append(platform)
        return wv
    }

    // Make `active`'s webview the audible / focused one; pause + mute media
    // on every other cached webview. Also re-points KVO observations at the
    // newly active webview so canGoBack / canGoForward / currentURL reflect
    // it. Actual show/hide of the SwiftUI mounts is driven by opacity /
    // allowsHitTesting in the container view — this method only handles the
    // "hidden webview shouldn't sing" side of things.
    //
    // WKWebView doesn't expose an `isMuted` property, so pausing + muting is
    // done via JS: pause every playing <video>/<audio> and set .muted = true.
    // The mute survives a later user-driven .play() call (media stays silent
    // until we un-mute on switch back).
    func showPlatform(_ active: String) {
        guard let activeWV = webView(for: active, create: true) else { return }
        coordinator.activate(activeWV)
        for (id, wv) in webViews {
            let isActive = (id == active)
            let js = isActive
                ? "document.querySelectorAll('video, audio').forEach(m => { m.muted = false; });"
                : "document.querySelectorAll('video, audio').forEach(m => { m.pause(); m.muted = true; });"
            wv.evaluateJavaScript(js, in: nil, in: FilteredWebView.extensionWorld) { _ in }
        }
    }
}

// MARK: - ViewModel

// @MainActor: this ObservableObject holds a WebViewCache that touches
// WKWebView (UIKit, main-actor-isolated) and mutates @Published state that
// drives SwiftUI. All existing call sites are already on the main thread
// (SwiftUI view code + explicit DispatchQueue.main.async / Task { @MainActor
// in ... } patterns), so tagging the class matches how it was already used.
@MainActor
class FilterSheetViewModel: ObservableObject {
    @Published var isPresented = false
    @Published var phrases: [String] = []
    @Published var themeMode: String = "dark"  // kept for JS bridge communication
    // Per-platform filtered-post counts. Each cached webview reports its own
    // count via feedfilterShowSheet / feedfilterPhrasesUpdated; the badge and
    // "View filtered posts (N)" label read the active platform's slot through
    // the `filteredCount` computed property below.
    @Published var filteredCounts: [String: Int] = [:]

    // Reads the currently-visible platform's count. SwiftUI re-computes it
    // when either `filteredCounts` or `selectedPlatform` changes, so
    // switching X → YouTube instantly reflects YT's count (or 0 if we
    // haven't heard from that webview yet) without waiting for a fresh push.
    var filteredCount: Int { filteredCounts[selectedPlatform] ?? 0 }
    @Published var canGoBack = false
    @Published var canGoForward = false
    @Published var currentURL: String = ""
    @Published var isEditingURL = false
    @Published var isFilteredModalOpen = false
    // AI detection (text + images, one signal) has no manual on/off switch —
    // it is driven entirely by the user's natural-language filter phrases
    // (see the extension's background/ai-intent.ts). `aiDetectionOn` mirrors
    // that derived state: loaded on demand via __ff_getAiTextFilterEnabled
    // and kept fresh by the aiDetectionOn field of the
    // feedfilterPhrasesUpdated push. `aiDetectionPending` dims the sheet's
    // sparkle indicator while the backend round trip that follows a tap is
    // in flight — the counterpart of the desktop indicator's `.pending`
    // class.
    @Published var aiDetectionOn: Bool = false
    @Published var aiDetectionPending: Bool = false
    // Initial values mirror the JS-side defaults (clampThreshold /
    // clampReplyThreshold / clampImageThreshold in shared/storage.ts);
    // real values load from storage via the __ff_ bridges.
    @Published var aiTextDetectionThreshold: Double = 0.5
    @Published var aiTextReplyDetectionThreshold: Double = 0.3
    @Published var aiImageDetectionThreshold: Double = 0.9
    // Mirrors chrome.storage.local["selectedModel"]. Settings views need
    // this on the main settings page to gate AI-text-detection UI: the
    // on-device classifier path doesn't require an Imbue backend, so the
    // toggle has to appear whenever EITHER Imbue is configured OR the user
    // has the on-device model selected.
    @Published var selectedModel: String = ""
    @Published var filterReplies: Bool = true
    // Which platform's filter phrases the sheet is currently viewing/editing.
    // Also drives which cached webview is visible / audible — the
    // FilteredWebViewContainer's ForEach reads this to pick the active mount.
    @Published var selectedPlatform: String = "twitter"

    // Per-platform WKWebView cache. Lazy so we can pass `self` into the
    // Coordinator's init without a chicken-and-egg problem. Held strongly by
    // the ViewModel; the Coordinator holds a strong sheetViewModel back —
    // that's a cycle in principle, but the ViewModel is the app's single
    // @StateObject singleton and never deallocates during runtime.
    lazy var cache: WebViewCache = WebViewCache(
        coordinator: FilteredWebView.WebCoordinator(sheetViewModel: self)
    )

    // Every existing call site keeps its `guard let webView = self.webView`
    // shape; the getter transparently resolves to the active platform's
    // webview via the cache. Non-creating — never spawns a webview on incident
    // reads. Returns nil until `selectPlatformAndNavigate` has run at least
    // once for `selectedPlatform`.
    var webView: WKWebView? { cache.webView(for: selectedPlatform, create: false) }

    static let contentWorld = WKContentWorld.world(name: "feedfilter")

    // Default the sheet's phrase list to the platform of the page currently
    // loaded — registry-driven so adding a new platform doesn't require a new
    // host-substring branch here.
    //
    // With the multi-webview cache, `selectedPlatform` also drives which
    // webview is visible; only overwrite it when the current URL matches a
    // known platform. Unknown hosts (e.g., an external link the user tapped
    // and hasn't backed out of yet) leave the selection alone so we don't
    // spuriously flip the visible webview.
    func syncPlatformToCurrentSite() {
        let host = (URL(string: currentURL)?.host ?? "").lowercased()
        if let match = Platforms.fromHost(host)?.id {
            selectedPlatform = match
        }
    }

    func selectPlatform(_ platform: String) {
        guard platform != selectedPlatform else { return }
        selectedPlatform = platform
        loadPhrases()
    }

    // Called by the PlatformPickerView + the NavBarView dropdown when the user
    // picks a platform. Sets the active platform immediately, then defers the
    // (potentially heavy) WebView build + phrase reload to the next main-
    // runloop tick.
    //
    // Why deferred: on the very first tap in the platform picker, the caller
    // also triggers a NavigationStack push (`navPath.append(...)`) in the
    // same runloop tick. If we synchronously build the WebView here — script
    // bundle loads, injection, WKWebView init, initial navigation — SwiftUI
    // can't commit the push animation to CoreAnimation until this returns,
    // and the first ~200-300ms of the slide stalls. Dispatching the heavy
    // work to the next tick lets SwiftUI commit first; the WebView then
    // spins up on main while the animation runs independently on the render
    // thread. On subsequent visits (already-cached webview), the deferred
    // work is trivially fast — the tick delay is invisible.
    //
    // No explicit `.load(...)` here: `cache.showPlatform` creates a new
    // webview on first visit via `WebViewFactory.make`, which kicks off the
    // initial feed navigation. Subsequent visits just flip visibility.
    func selectPlatformAndNavigate(_ platform: String) {
        selectedPlatform = platform
        // Two paths, distinguished by whether a fresh WebView needs to be
        // built:
        //
        // - Already cached: `showPlatform` is fast (KVO re-point + a small
        //   JS pause/mute per webview). Run synchronously — there's no
        //   animation to protect and any deferral is wasted latency.
        //
        // - Not cached: `showPlatform` will call `WebViewFactory.make`,
        //   which does bundle disk-reads for ChromePolyfill / background-app
        //   / content.js / DOMPurify / three adapter scripts / three CSS
        //   files, base64 + string concatenation for the popup bridge,
        //   WKUserContentController wiring, WKWebView init, and the initial
        //   `.load(URLRequest(...))`. That's 150-300ms of main-thread work.
        //   If a NavigationStack push is animating concurrently (the picker
        //   case), blocking main during it stalls the slide. Sleep for the
        //   animation duration (~350ms + buffer) so the transition
        //   completes on CoreAnimation before we sink into the build.
        let needsCreation = cache.webView(for: platform, create: false) == nil
        if needsCreation {
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 400_000_000)
                guard let self = self else { return }
                self.cache.showPlatform(platform)
                self.loadPhrases()
            }
        } else {
            cache.showPlatform(platform)
            loadPhrases()
        }
    }

    // Load the selected platform's phrases from the (shared, native-backed)
    // store via the per-platform bridge — works regardless of which site the
    // WebView is on.
    func loadPhrases() {
        guard let webView = webView else { return }
        let platform = selectedPlatform
        Task { @MainActor in
            do {
                let result = try await webView.callAsyncJavaScript(
                    "return await window.__ff_getPhrases(siteId)",
                    arguments: ["siteId": platform],
                    in: nil,
                    contentWorld: Self.contentWorld
                )
                // Ignore a stale response if the user switched platforms mid-flight.
                guard platform == self.selectedPlatform else { return }
                if let arr = result as? [String] {
                    self.phrases = arr
                } else if let arr = result as? [Any] {
                    self.phrases = arr.compactMap { $0 as? String }
                }
            } catch {
                print("[FeedFilter] loadPhrases error: \(error)")
            }
        }
    }

    func addPhrase(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        // Optimistic insert for snappiness; loadPhrases reconciles afterward.
        if !phrases.contains(trimmed) { phrases.append(trimmed) }
        guard let webView = webView else { return }
        let platform = selectedPlatform
        Task { @MainActor in
            _ = try? await webView.callAsyncJavaScript(
                "return await window.__ff_addPhraseFor(siteId, text)",
                arguments: ["siteId": platform, "text": trimmed],
                in: nil,
                contentWorld: Self.contentWorld
            )
            self.loadPhrases()
        }
    }

    func removePhrase(_ phrase: String) {
        withAnimation {
            phrases.removeAll { $0 == phrase }
        }
        guard let webView = webView else { return }
        let platform = selectedPlatform
        Task { @MainActor in
            _ = try? await webView.callAsyncJavaScript(
                "return await window.__ff_removePhraseFor(siteId, phrase)",
                arguments: ["siteId": platform, "phrase": phrase],
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

    func loadFilterReplies() {
        Task { @MainActor in
            let data = await getStorage(keys: ["filterReplies"])
            // Treat missing as true so users get the historical behavior
            // until they explicitly opt out via the toggle.
            if let value = data["filterReplies"] as? Bool {
                self.filterReplies = value
            } else {
                self.filterReplies = true
            }
        }
    }

    func setFilterReplies(_ enabled: Bool) {
        filterReplies = enabled
        Task { @MainActor in
            await setStorage(["filterReplies": enabled])
        }
    }

    func loadAiDetectionState() {
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
                    self.aiDetectionOn = value
                }
            } catch {
                print("[FeedFilter] loadAiDetectionState error: \(error)")
            }
        }
    }

    // Confirmed state pushed from JS. `confirmed` is true only for pushes
    // triggered by an aiFilterIntent storage write — the same signal that
    // clears the desktop indicator's `.pending` class — so unrelated pushes
    // (phrase edits, filtered-count changes) can't clear the pending dim
    // early while the backend is still judging the seed phrase.
    func applyAiDetectionState(_ on: Bool, confirmed: Bool) {
        aiDetectionOn = on
        if confirmed {
            aiDetectionPending = false
            aiPendingFallbackTask?.cancel()
            aiPendingFallbackTask = nil
        }
    }

    private var aiPendingFallbackTask: Task<Void, Never>?

    // Toggle AI detection through the natural-language phrase mechanism —
    // the sparkle indicator's tap action, mirroring the desktop indicator
    // (toggleAiDetectionViaPhrases in content/ui.ts). Off→on adds the seed
    // phrase "AI slop" and waits for the backend to judge it; on→off deletes
    // every AI phrase (instant, no round trip). Confirmation arrives via the
    // feedfilterPhrasesUpdated push; the fallback timer keeps a dropped
    // round trip from wedging the indicator (desktop has the same failure
    // mode but re-renders often enough to recover).
    func toggleAiDetection() {
        guard let webView = webView else { return }
        aiDetectionPending = true
        aiPendingFallbackTask?.cancel()
        aiPendingFallbackTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            guard !Task.isCancelled, let self = self else { return }
            self.aiDetectionPending = false
            self.loadAiDetectionState()
        }
        Task { @MainActor in
            do {
                _ = try await webView.callAsyncJavaScript(
                    "return await window.__ff_toggleAiDetection()",
                    arguments: [:],
                    in: nil,
                    contentWorld: Self.contentWorld
                )
            } catch {
                print("[FeedFilter] toggleAiDetection error: \(error)")
                self.aiDetectionPending = false
                self.aiPendingFallbackTask?.cancel()
                self.aiPendingFallbackTask = nil
            }
            // The seed phrase appears in (or the AI phrases vanish from) the
            // current site's list immediately — reflect it in the sheet.
            self.loadPhrases()
        }
    }

    func loadSelectedModel() {
        guard let webView = webView else { return }
        Task { @MainActor in
            do {
                let result = try await webView.callAsyncJavaScript(
                    "const d = await window.__ff_getStorage(['selectedModel']); return d.selectedModel || '';",
                    arguments: [:],
                    in: nil,
                    contentWorld: Self.contentWorld
                )
                if let value = result as? String {
                    self.selectedModel = value
                }
            } catch {
                print("[FeedFilter] loadSelectedModel error: \(error)")
            }
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

    // Reply/comment AI-text threshold. The JS pipeline applies this instead
    // of aiTextDetectionThreshold when the post is a reply — same storage key
    // the desktop popup's "Comment confidence threshold" slider writes.
    func loadAiTextReplyDetectionThreshold() {
        guard let webView = webView else { return }
        Task { @MainActor in
            do {
                let result = try await webView.callAsyncJavaScript(
                    "return await window.__ff_getAiTextReplyDetectionThreshold()",
                    arguments: [:],
                    in: nil,
                    contentWorld: Self.contentWorld
                )
                if let value = result as? Double {
                    self.aiTextReplyDetectionThreshold = value
                } else if let value = result as? NSNumber {
                    self.aiTextReplyDetectionThreshold = value.doubleValue
                }
            } catch {
                print("[FeedFilter] loadAiTextReplyDetectionThreshold error: \(error)")
            }
        }
    }

    func setAiTextReplyDetectionThreshold(_ value: Double) {
        let clamped = min(1.0, max(0.0, value))
        aiTextReplyDetectionThreshold = clamped
        guard let webView = webView else { return }
        Task {
            try? await webView.callAsyncJavaScript(
                "return await window.__ff_setAiTextReplyDetectionThreshold(value)",
                arguments: ["value": clamped],
                in: nil,
                contentWorld: Self.contentWorld
            )
        }
    }

    func loadAiImageDetectionThreshold() {
        guard let webView = webView else { return }
        Task { @MainActor in
            do {
                let result = try await webView.callAsyncJavaScript(
                    "return await window.__ff_getAiImageDetectionThreshold()",
                    arguments: [:],
                    in: nil,
                    contentWorld: Self.contentWorld
                )
                if let value = result as? Double {
                    self.aiImageDetectionThreshold = value
                } else if let value = result as? NSNumber {
                    self.aiImageDetectionThreshold = value.doubleValue
                }
            } catch {
                print("[FeedFilter] loadAiImageDetectionThreshold error: \(error)")
            }
        }
    }

    func setAiImageDetectionThreshold(_ value: Double) {
        let clamped = min(1.0, max(0.0, value))
        aiImageDetectionThreshold = clamped
        guard let webView = webView else { return }
        Task {
            try? await webView.callAsyncJavaScript(
                "return await window.__ff_setAiImageDetectionThreshold(value)",
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
        isPresented = false
        // Share must run on the Twitter webview — the JS bridge clicks X's
        // compose link, which only exists on x.com. If the user is currently
        // viewing YouTube or LinkedIn, switch first (creates the Twitter
        // webview if it wasn't visited yet). ensureOnX below still runs to
        // handle the case where the Twitter webview happens to be on a
        // non-feed page.
        if selectedPlatform != "twitter" {
            selectPlatformAndNavigate("twitter")
        }
        guard let webView = webView else { return }
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
        // No ensureOnX: chrome.storage is now a native store shared across
        // origins, and the __ff_* bridge is present on whatever site (x.com /
        // m.youtube.com) the WebView is currently showing.
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
        // No ensureOnX — see getStorage. Writing the current site's key fires
        // chrome.storage.onChanged in-page so content.js re-evaluates.
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
                #if DEBUG
                // Dev-only: wipe the onboarding flag and dismiss the sheet.
                // @AppStorage in FilteredWebViewContainer observes UserDefaults
                // and re-shows OnboardingView as soon as the value flips, so no
                // relaunch is needed. Ladybug icon matches Xcode's debug idiom.
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        UserDefaults.standard.set(false, forKey: "hasCompletedOnboarding")
                        viewModel.isPresented = false
                    } label: {
                        Image(systemName: "ladybug")
                            .font(.system(size: 17, weight: .regular))
                    }
                    .accessibilityLabel("Reset onboarding (debug)")
                }
                #endif
                // AI-detection indicator, the native counterpart of the
                // sparkle at the top-right of the desktop filter box
                // (.filter-ai-indicator in content.css). It reports the
                // natural-language-derived state AND toggles it — but only
                // through the phrase mechanism itself; there is no override
                // switch (see the extension's background/ai-intent.ts).
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        viewModel.toggleAiDetection()
                    } label: {
                        Image(systemName: "sparkles")
                            .font(.system(size: 17, weight: .regular))
                            .foregroundStyle(viewModel.aiDetectionOn ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                    }
                    .opacity(viewModel.aiDetectionPending ? 0.55 : 1.0)
                    .disabled(viewModel.aiDetectionPending)
                    .accessibilityLabel(viewModel.aiDetectionOn
                        ? "Removing AI-generated content — your filter phrases ask for it. Tap to stop (removes those phrases)."
                        : "Tap to remove AI-generated content from your feed (adds the filter phrase \"AI slop\").")
                }
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
            viewModel.loadAiDetectionState()
            viewModel.syncPlatformToCurrentSite()
            viewModel.loadPhrases()
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

// Mirrors the desktop popup's simplified top level: only the Cloud/On-Device
// filtering-mode choice, the selected on-device model's download status, and
// the filter-replies toggle are headline settings. Everything else (full
// model list, BYOK providers, AI-detection thresholds) lives in
// AdvancedSettingsView, the counterpart of the popup's collapsed
// "Advanced Settings" accordion.
struct BouncerSettingsView: View {
    @ObservedObject var viewModel: FilterSheetViewModel
    @ObservedObject private var localService = LocalInferenceService.shared

    // The Imbue-hosted "Cloud" option requires Firebase App Check. On builds
    // shipped without a GoogleService-Info plist it is unusable, so hide it.
    private var hasImbueBackend: Bool {
        AppCheckBridge.shared.isAvailable
    }

    // The headline on-device model, the native counterpart of the popup's
    // single On-Device radio. The full catalog stays on the AI-providers
    // page under Advanced Settings.
    private var headlineLocalModel: LocalInferenceService.LocalModel {
        LocalInferenceService.models[0]
    }

    private var selectedLocalModel: LocalInferenceService.LocalModel? {
        LocalInferenceService.model(forKey: viewModel.selectedModel)
    }

    // On a fresh install `selectedModel` is unset, but the JS pipeline
    // defaults to Imbue on Imbue-enabled builds — treat empty as Cloud.
    private var isCloudSelected: Bool {
        viewModel.selectedModel == imbueModelKey
            || (viewModel.selectedModel.isEmpty && hasImbueBackend)
    }

    // A BYOK model picked on the AI-providers page matches neither headline
    // row — name it in the section footer, mirroring the popup's
    // "set in Advanced Settings" note under the radios.
    private var advancedSelectionLabel: String? {
        let key = viewModel.selectedModel
        guard !key.isEmpty, key != imbueModelKey, selectedLocalModel == nil else { return nil }
        guard let colon = key.firstIndex(of: ":") else { return key }
        let providerId = String(key[..<colon])
        let modelId = String(key[key.index(after: colon)...])
        let spec = providerSpecs.first(where: { $0.id == providerId })
        return spec?.models.first(where: { $0.id == modelId })?.display ?? modelId
    }

    // Load a brand logo PNG out of the bundled icons/ folder reference (same
    // files the desktop popup uses) and render it as a template image so it
    // tints with the row's foreground color — mirrors the desktop's
    // `filter: invert(1)` dark-mode rule.
    @ViewBuilder
    private func contactRow(icon: String, text: String) -> some View {
        HStack(spacing: 12) {
            if let url = Bundle.main.url(forResource: icon, withExtension: "png", subdirectory: "icons"),
               let data = try? Data(contentsOf: url),
               let ui = UIImage(data: data) {
                Image(uiImage: ui.withRenderingMode(.alwaysTemplate))
                    .resizable()
                    .scaledToFit()
                    .frame(width: 20, height: 20)
                    .foregroundStyle(.primary)
            }
            Text(text)
        }
    }

    var body: some View {
        Form {
            Section {
                if hasImbueBackend {
                    cloudRow
                }
                onDeviceRow
                // Download controls sit directly under the On-Device row —
                // shown by default (not just once selected), because the
                // model must be downloaded before On-Device becomes
                // selectable at all. Counterpart of the popup's
                // localModelSection.
                if let model = selectedLocalModel
                    ?? (headlineLocalModel.isSupportedOnThisDevice ? headlineLocalModel : nil) {
                    onDeviceStatusRows(model)
                }
            } header: {
                Text("Filtering Mode")
            } footer: {
                if let label = advancedSelectionLabel {
                    Text("Using \(label) (set in Advanced Settings)")
                }
            }

            // Headline toggle, same storage key the JS pipeline reads.
            // Unlike desktop, iOS intentionally omits the per-site "enable
            // Bouncer" master toggles — filtering is always on per site.
            Section {
                Toggle(isOn: Binding(
                    get: { viewModel.filterReplies },
                    set: { viewModel.setFilterReplies($0) }
                )) {
                    Text("Also filter replies in threads")
                }
            }

            // Everything below Advanced Settings is power-user surface:
            // full model list, BYOK providers, AI-detection thresholds.
            Section {
                NavigationLink {
                    AdvancedSettingsView(viewModel: viewModel)
                } label: {
                    HStack {
                        Image(systemName: "gearshape.2")
                            .foregroundStyle(.tint)
                            .frame(width: 24)
                        Text("Advanced Settings")
                    }
                }
            }

            Section {
                Link(destination: URL(string: "https://x.com/Millanphilipose")!) {
                    contactRow(icon: "x-logo", text: "X (@Millanphilipose)")
                }
                Link(destination: URL(string: "https://github.com/imbue-ai/bouncer")!) {
                    contactRow(icon: "github-logo", text: "GitHub")
                }
                Link(destination: URL(string: "https://discord.gg/bcG87mkdN9")!) {
                    contactRow(icon: "discord-logo", text: "Discord")
                }
            } header: {
                Text("Contact us")
            }

            Section {
                Link(destination: URL(string: "https://apps.apple.com/us/app/bouncer-heal-your-feed/id6759466393")!) {
                    Label("Rate us on the App Store", systemImage: "star.fill")
                }
            } footer: {
                Text("Enjoying Bouncer? Leave a review — it really helps.")
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            viewModel.loadFilterReplies()
            viewModel.loadSelectedModel()
        }
    }

    private var cloudRow: some View {
        Button {
            Task { await selectModel(imbueModelKey) }
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Cloud")
                        .foregroundStyle(.primary)
                    Text("Fast and free.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if isCloudSelected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(.tint)
                }
            }
            // Hit-test the whole row, not just the opaque text/checkmark —
            // the Spacer's transparent area doesn't register taps otherwise.
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var onDeviceRow: some View {
        let model = headlineLocalModel
        if !model.isSupportedOnThisDevice {
            // Same RAM gate as onboarding and the AI-providers list.
            VStack(alignment: .leading, spacing: 2) {
                Text("On-Device")
                    .foregroundStyle(.secondary)
                Text("Not available on this iPhone — requires \(model.requiredRAMDisplay)+ RAM.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } else {
            // Not selectable until the model's weights are on disk — the
            // Download button below is the only affordance before that.
            let ready = localModelIsSelectable(localService.downloadStatus(for: model))
            Button {
                guard ready else { return }
                Task { await selectModel(model.selectedModelKey) }
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("On-Device")
                            .foregroundStyle(ready ? .primary : .secondary)
                        Text(ready
                            ? "Nothing leaves your phone."
                            : "Nothing leaves your phone. Download the model to enable.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if selectedLocalModel != nil {
                        Image(systemName: "checkmark")
                            .foregroundStyle(.tint)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!ready)
        }
    }

    @ViewBuilder
    private func onDeviceStatusRows(_ model: LocalInferenceService.LocalModel) -> some View {
        switch localService.downloadStatus(for: model) {
        case .notDownloaded:
            Button("Download (\(model.approxSize))") {
                localService.startDownload(model)
            }
        case .error(let message):
            VStack(alignment: .leading, spacing: 4) {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                Button("Retry download") {
                    localService.startDownload(model)
                }
            }
        case .downloading(let progress):
            VStack(alignment: .leading, spacing: 8) {
                ProgressView(value: progress)
                // .borderless button style: without it, both buttons share one
                // row-wide hit region in Form/List and a single tap fires every
                // action closure in the row.
                HStack {
                    Button("Pause") { localService.pauseDownload() }
                        .buttonStyle(.borderless)
                    Spacer()
                    Text("\(Int((progress * 100).rounded()))%")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                    Spacer()
                    Button("Cancel", role: .destructive) { localService.cancelDownload() }
                        .buttonStyle(.borderless)
                }
            }
        case .paused(let progress):
            VStack(alignment: .leading, spacing: 8) {
                ProgressView(value: progress)
                HStack {
                    Button("Resume") { localService.startDownload(model) }
                        .buttonStyle(.borderless)
                    Spacer()
                    Text("Paused at \(Int((progress * 100).rounded()))%")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                    Spacer()
                    Button("Cancel", role: .destructive) { localService.cancelDownload() }
                        .buttonStyle(.borderless)
                }
            }
        case .downloaded, .ready, .loading:
            EmptyView()
        }
    }

    @MainActor
    private func selectModel(_ modelKey: String) async {
        // When an on-device variant is picked, switch the native engine to it
        // (unloads the current model; the new one lazily loads on next classify).
        if let model = LocalInferenceService.model(forKey: modelKey) {
            localService.selectModel(model)
        }
        await viewModel.setStorage(["selectedModel": modelKey])
        viewModel.selectedModel = modelKey
        await viewModel.clearModelCache()
    }
}

// MARK: - Advanced Settings

// Power-user surface folded out of the main settings page, mirroring the
// desktop popup's collapsed "Advanced Settings" accordion: the full model
// list / BYOK providers and the AI-detection threshold sliders.
struct AdvancedSettingsView: View {
    @ObservedObject var viewModel: FilterSheetViewModel

    // Mirrors viewModel.aiTextDetectionThreshold during a drag so the slider
    // and percentage update smoothly without round-tripping through JS on
    // every frame. We only persist when the drag ends.
    @State private var draftThreshold: Double = 0.9
    @State private var isDragging: Bool = false

    @State private var draftReplyThreshold: Double = 0.3
    @State private var isDraggingReply: Bool = false

    @State private var draftImageThreshold: Double = 0.9
    @State private var isDraggingImage: Bool = false

    private var displayThreshold: Double {
        isDragging ? draftThreshold : viewModel.aiTextDetectionThreshold
    }

    private var displayReplyThreshold: Double {
        isDraggingReply ? draftReplyThreshold : viewModel.aiTextReplyDetectionThreshold
    }

    private var displayImageThreshold: Double {
        isDraggingImage ? draftImageThreshold : viewModel.aiImageDetectionThreshold
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

            // AI text/image detection is available when either Imbue is configured
            // OR the on-device classifier model has been picked. There is no
            // manual on/off toggle — detection is driven entirely by the
            // user's natural-language filter phrases (mirroring the desktop
            // popup, which shows only the threshold sliders, gated on the
            // derived state).
            if hasImbueBackend || viewModel.selectedModel.hasPrefix("iosLocal:") {
                Section {
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
                    .disabled(!viewModel.aiDetectionOn)
                    .opacity(viewModel.aiDetectionOn ? 1.0 : 0.5)

                    // Replies/comments get their own (typically lower)
                    // threshold — the desktop popup's "Comment confidence
                    // threshold" slider. Same storage key the pipeline reads
                    // for reply posts.
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Comment confidence threshold")
                            Spacer()
                            Text("\(Int(round(displayReplyThreshold * 100)))%")
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                        Slider(
                            value: Binding(
                                get: { displayReplyThreshold },
                                set: { draftReplyThreshold = $0 }
                            ),
                            in: 0...1
                        ) {
                            Text("Comment confidence threshold")
                        } minimumValueLabel: {
                            Text("0%").font(.caption2).foregroundStyle(.secondary)
                        } maximumValueLabel: {
                            Text("100%").font(.caption2).foregroundStyle(.secondary)
                        } onEditingChanged: { editing in
                            if editing {
                                draftReplyThreshold = viewModel.aiTextReplyDetectionThreshold
                                isDraggingReply = true
                            } else {
                                isDraggingReply = false
                                viewModel.setAiTextReplyDetectionThreshold(draftReplyThreshold)
                            }
                        }
                        Text("Applied to replies and comments instead of the threshold above.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                    .disabled(!viewModel.aiDetectionOn)
                    .opacity(viewModel.aiDetectionOn ? 1.0 : 0.5)
                } header: {
                    Text("AI Text Detection")
                } footer: {
                    Text("Hide posts whose text appears to be written by AI. Posts at or above this confidence are hidden. Turns on automatically when your filter phrases ask for AI-generated content to be removed (e.g. \u{201C}AI slop\u{201D}), and off when they don\u{2019}t.")
                }
            }

            // No on-device image classifier yet — image-detection UI stays
            // gated on the Imbue backend.
            if hasImbueBackend {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Confidence threshold")
                            Spacer()
                            Text("\(Int(round(displayImageThreshold * 100)))%")
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                        Slider(
                            value: Binding(
                                get: { displayImageThreshold },
                                set: { draftImageThreshold = $0 }
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
                                draftImageThreshold = viewModel.aiImageDetectionThreshold
                                isDraggingImage = true
                            } else {
                                isDraggingImage = false
                                viewModel.setAiImageDetectionThreshold(draftImageThreshold)
                            }
                        }
                    }
                    .padding(.vertical, 4)
                    .disabled(!viewModel.aiDetectionOn)
                    .opacity(viewModel.aiDetectionOn ? 1.0 : 0.5)
                } header: {
                    Text("AI Image Detection")
                } footer: {
                    Text("Hide posts whose images appear to be AI-generated. Posts whose most-suspect image is at or above this confidence are hidden. Engages together with AI text detection, driven by your filter phrases.")
                }
            }
        }
        .navigationTitle("Advanced Settings")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            viewModel.loadSelectedModel()
            // Text-detection settings load whenever the section can appear:
            // Imbue available OR on-device model selected. Image-detection
            // settings stay gated on Imbue (no on-device image classifier).
            viewModel.loadAiDetectionState()
            viewModel.loadAiTextDetectionThreshold()
            viewModel.loadAiTextReplyDetectionThreshold()
            if hasImbueBackend {
                viewModel.loadAiImageDetectionThreshold()
            }
        }
    }
}

// MARK: - Providers Settings

// On-device model keys are "iosLocal:<id>" where <id> comes from
// LocalInferenceService.models. Use LocalInferenceService.model(forKey:) to
// resolve a selectedModel string to a catalog entry.

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
let imbueModelKey = "imbue"

// Shared by the main settings page's On-Device Model section and the
// AI-providers model rows so the two surfaces never describe the same
// download state differently.
private func localModelStatusText(
    _ model: LocalInferenceService.LocalModel,
    _ status: LocalInferenceService.ModelStatus,
    service: LocalInferenceService
) -> String {
    switch status {
    case .notDownloaded:
        return "Not downloaded — \(model.approxSize)"
    case .downloading(let progress):
        let pct = Int((progress * 100).rounded())
        return "Downloading \(pct)% — \(service.downloadedBytesDisplay) / \(service.totalBytesDisplay)"
    case .paused(let progress):
        let pct = Int((progress * 100).rounded())
        return "Paused at \(pct)%"
    case .downloaded:
        return "Downloaded — tap to use"
    case .loading:
        return "Loading…"
    case .ready:
        return "Ready — active"
    case .error(let message):
        return "Error: \(message)"
    }
}

// Selection gate shared by the main settings page's On-Device row and the
// AI-providers model rows: a local model is only selectable once its weights
// are on disk. Before that the row is greyed out and the Download button
// below it is the only affordance.
private func localModelIsSelectable(_ status: LocalInferenceService.ModelStatus) -> Bool {
    switch status {
    case .downloaded, .ready: return true
    default: return false
    }
}

struct ProvidersSettingsView: View {
    @ObservedObject var viewModel: FilterSheetViewModel
    @ObservedObject private var localService = LocalInferenceService.shared

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

            onDeviceSection

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
        if LocalInferenceService.model(forKey: selectedModel) != nil { return "On-device" }
        guard let colon = selectedModel.firstIndex(of: ":") else { return "" }
        let providerId = String(selectedModel[..<colon])
        return providerSpecs.first(where: { $0.id == providerId })?.displayName ?? providerId
    }

    private var currentModelLabel: String {
        if selectedModel == imbueModelKey { return "Imbue (default)" }
        if let m = LocalInferenceService.model(forKey: selectedModel) { return "\(m.displayName) (on-device)" }
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
    private var onDeviceSection: some View {
        Section {
            ForEach(LocalInferenceService.models) { model in
                onDeviceModelRow(model)
            }
        } header: {
            Text("On-device")
        } footer: {
            Text("Runs Gemma locally for phrase filtering and AI-text detection — no posts leave your phone. Download a model, then tap it to make it active. Requires Wi-Fi and an iPhone with 6 GB+ RAM.")
        }
    }

    @ViewBuilder
    private func onDeviceModelRow(_ model: LocalInferenceService.LocalModel) -> some View {
        if !model.isSupportedOnThisDevice {
            // Same RAM gate as onboarding and the popup's provider list, in
            // the greyed-out-with-reason style: no Download button — the
            // engine can't run within this device's memory budget.
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(model.displayName) (on-device)")
                        .foregroundStyle(.secondary)
                    Text("Not available on this iPhone — requires \(model.requiredRAMDisplay)+ RAM.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
        } else {
            let status = localService.downloadStatus(for: model)
            let ready = localModelIsSelectable(status)
            Button {
                guard ready else { return }
                Task { await selectModel(model.selectedModelKey) }
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(model.displayName) (on-device)")
                            .foregroundStyle(ready ? .primary : .secondary)
                        Text(localModelStatusText(model, status, service: localService))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if selectedModel == model.selectedModelKey {
                        Image(systemName: "checkmark")
                            .foregroundStyle(.tint)
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(!ready)

            if case .downloading(let progress) = status {
                ProgressView(value: progress)
            } else if case .paused(let progress) = status {
                ProgressView(value: progress)
            }

            onDeviceActionButtons(model, status)
        }
    }

    @ViewBuilder
    private func onDeviceActionButtons(
        _ model: LocalInferenceService.LocalModel,
        _ status: LocalInferenceService.ModelStatus
    ) -> some View {
        switch status {
        case .notDownloaded, .error:
            Button("Download") {
                localService.startDownload(model)
            }
        case .downloading:
            // .borderless button style: without it, both buttons share one
            // row-wide hit region in Form/List and a single tap fires every
            // action closure in the row.
            HStack {
                Button("Pause") { localService.pauseDownload() }
                    .buttonStyle(.borderless)
                Spacer()
                Button("Cancel", role: .destructive) { localService.cancelDownload() }
                    .buttonStyle(.borderless)
            }
        case .paused:
            HStack {
                Button("Resume") { localService.startDownload(model) }
                    .buttonStyle(.borderless)
                Spacer()
                Button("Cancel", role: .destructive) { localService.cancelDownload() }
                    .buttonStyle(.borderless)
            }
        case .downloaded, .ready, .loading:
            Button("Delete", role: .destructive) {
                if selectedModel == model.selectedModelKey {
                    Task { await selectModel(imbueModelKey) }
                }
                localService.deleteModel(model)
            }
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
        viewModel.selectedModel = self.selectedModel
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
            viewModel.selectedModel = fallback
        }
        await viewModel.clearModelCache()
    }

    @MainActor
    private func selectModel(_ modelKey: String) async {
        // When an on-device variant is picked, switch the native engine to it
        // (unloads the current model; the new one lazily loads on next classify).
        if let model = LocalInferenceService.model(forKey: modelKey) {
            localService.selectModel(model)
        }
        await viewModel.setStorage(["selectedModel": modelKey])
        selectedModel = modelKey
        viewModel.selectedModel = modelKey
        await viewModel.clearModelCache()
    }
}

// MARK: - Container View

struct FilteredWebViewContainer: View {
    @StateObject var viewModel = FilterSheetViewModel()
    // @AppStorage so external UserDefaults writes (e.g. the DEBUG-only "reset
    // onboarding" button in the filter sheet toolbar) propagate reactively —
    // no explicit re-read required for the change to re-show OnboardingView.
    @AppStorage("hasCompletedOnboarding") private var isOnboarded: Bool = false
    // NavigationStack path: empty means the picker is the visible root; a
    // single appended platform id means the user has picked and the feed is
    // pushed on top. There's no way back to the picker within a session, so
    // the path is append-once — the iOS-native push transition (slide + parallax
    // + Reduce-Motion cross-fade) fires exactly once on that first append.
    @State private var navPath: [String] = []

    var body: some View {
        ZStack {
            NavigationStack(path: $navPath) {
                PlatformPickerView { platformId in
                    viewModel.selectPlatformAndNavigate(platformId)
                    navPath.append(platformId)
                }
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: String.self) { _ in
                    MainFeedView(viewModel: viewModel)
                        // Suppress the back button + edge-swipe pop so the
                        // WebView's own `allowsBackForwardNavigationGestures`
                        // keeps working for in-page history.
                        .navigationBarBackButtonHidden(true)
                        .toolbar(.hidden, for: .navigationBar)
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
        // If onboarding is re-triggered (DEBUG-only via the ladybug button),
        // pop the NavigationStack back to its root so the platform picker
        // shows again after the user completes onboarding. Otherwise the
        // previously-pushed MainFeedView would still be on top and the
        // picker would be skipped entirely.
        .onChange(of: isOnboarded) { _, newValue in
            if !newValue {
                navPath.removeAll()
            }
        }
    }
}

// MARK: - Main Feed View
//
// The pushed destination behind the platform picker. Owns the WebView cache
// mounts, the URL-editing / sheet-tap dismissal overlays, the bottom
// NavBarView, and the presentation of the filter sheet. Lifted out of
// FilteredWebViewContainer so the NavigationStack has a clean destination
// to render — no logic changes vs. the previous inline structure.

private struct MainFeedView: View {
    @ObservedObject var viewModel: FilterSheetViewModel

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                // Mount every WebView the cache has created — one per
                // visited platform. `.opacity` + `.allowsHitTesting` show
                // only the active one; the rest stay hydrated in the view
                // hierarchy so a switch back is instant.
                ForEach(viewModel.cache.visitedPlatforms, id: \.self) { platformId in
                    if let wv = viewModel.cache.webView(for: platformId) {
                        let isActive = viewModel.selectedPlatform == platformId
                        FilteredWebView(webView: wv)
                            .opacity(isActive ? 1 : 0)
                            .allowsHitTesting(isActive)
                    }
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
    }
}

// MARK: - Navigation Bar

struct NavBarView: View {
    @ObservedObject var viewModel: FilterSheetViewModel
    var bouncerTip = BouncerButtonTip()

    // Registry-driven so a new platform in Platforms.all shows up in the
    // dropdown without touching this view.
    private var currentPlatformName: String {
        Platforms.byId(viewModel.selectedPlatform)?.displayName ?? "X (Twitter)"
    }

    var body: some View {
        VStack(spacing: 0) {
            Divider()

            // Platform dropdown — native SwiftUI Picker with .menu style.
            // Renders the selected platform in the accent color followed by
            // the standard up/down chevron glyph, and shows a checkmark on the
            // active row in the popup. Picking navigates the WebView.
            Picker(
                "Platform",
                selection: Binding(
                    get: { viewModel.selectedPlatform },
                    set: { viewModel.selectPlatformAndNavigate($0) }
                )
            ) {
                ForEach(Platforms.all, id: \.id) { platform in
                    Text(platform.displayName).tag(platform.id)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .center)
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
        .onChange(of: viewModel.currentURL) { _, newURL in
            if newURL.contains("x.com/home") || newURL.contains("twitter.com/home") {
                UserDefaults.standard.set(true, forKey: "hasLoggedIn")
                Task { await BouncerButtonTip.loggedIn.donate() }
            }
        }
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
