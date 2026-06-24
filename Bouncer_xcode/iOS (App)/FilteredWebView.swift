//
//  FilteredWebView.swift
//  iOS (App)
//
//  WKWebView that loads x.com and injects extension scripts for feed filtering.
//

import SwiftUI
import WebKit

struct FilteredWebView: UIViewRepresentable {

    var sheetViewModel: FilterSheetViewModel

    func makeCoordinator() -> Coordinator {
        Coordinator(sheetViewModel: sheetViewModel)
    }

    func makeUIView(context: Context) -> WKWebView {
        let contentController = WKUserContentController()
        contentController.add(context.coordinator, contentWorld: Self.extensionWorld, name: "feedfilterLog")
        contentController.add(context.coordinator, contentWorld: Self.extensionWorld, name: "feedfilterShowSheet")
        contentController.add(context.coordinator, contentWorld: Self.extensionWorld, name: "feedfilterPhrasesUpdated")
        contentController.add(context.coordinator, contentWorld: Self.extensionWorld, name: "feedfilterGetAppCheckToken")
        contentController.add(context.coordinator, contentWorld: Self.extensionWorld, name: "feedfilterWsOpen")
        contentController.add(context.coordinator, contentWorld: Self.extensionWorld, name: "feedfilterWsSend")
        contentController.add(context.coordinator, contentWorld: Self.extensionWorld, name: "feedfilterWsClose")
        contentController.add(context.coordinator, contentWorld: Self.extensionWorld, name: "feedfilterModalClosed")
        // Reply-style handler backing chrome.storage.local/sync with a native
        // UserDefaults store, shared across origins (x.com, m.youtube.com, linkedin.com).
        contentController.addScriptMessageHandler(context.coordinator, contentWorld: Self.extensionWorld, name: "feedfilterStorage")
        // iOS Local Inference: classify/detect bridges for the on-device Gemma model.
        contentController.add(context.coordinator, contentWorld: Self.extensionWorld, name: "feedfilterLocalClassify")
        contentController.add(context.coordinator, contentWorld: Self.extensionWorld, name: "feedfilterLocalAiTextDetect")
        injectScripts(into: contentController)

        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        if UIDevice.current.userInterfaceIdiom == .pad {
            webView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
        } else {
            webView.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
        }
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }

        // Initial URL follows whichever platform the user picked on the
        // PlatformPickerView. Registry-driven; falls back to X's home/login
        // pair so first-run sign-in still surfaces the right page.
        let def = Platforms.byId(sheetViewModel.selectedPlatform)
            ?? Platforms.byId("twitter")
        let urlString: String = {
            if let def = def, let login = def.loginURL,
               !UserDefaults.standard.bool(forKey: "hasLoggedIn") {
                return login
            }
            return def?.feedURL ?? "https://x.com"
        }()
        if let url = URL(string: urlString) {
            webView.load(URLRequest(url: url))
        }

        context.coordinator.sheetViewModel.webView = webView
        context.coordinator.observeWebView(webView)
        WebSocketBridge.shared.webView = webView

        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    // MARK: - Script Injection

    static let extensionWorld = WKContentWorld.world(name: "feedfilter")

    private func injectScripts(into controller: WKUserContentController) {
        let world = Self.extensionWorld

        // 0. Store extractors — injected into the PAGE world (not the extension
        // world) at document start, because they must read JS data off the
        // site's custom elements, which only the page world can see. On desktop
        // the adapters inject these via chrome.runtime.getURL; that scheme can't
        // load in a WKWebView, so we bundle + inject them natively here. They
        // bridge data back to the content script via DOM CustomEvents.
        if let source = loadBundledScript(named: "fiber-extractor", ext: "js", subdirectory: "adapters/twitter") {
            controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
            print("[FeedFilter] Injected fiber-extractor.js (page world)")
        } else { print("[FeedFilter] fiber-extractor.js NOT bundled") }
        if let source = loadBundledScript(named: "lockup-extractor", ext: "js", subdirectory: "adapters/youtube") {
            controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
            print("[FeedFilter] Injected lockup-extractor.js (page world)")
        } else { print("[FeedFilter] lockup-extractor.js NOT bundled") }

        // 1. ChromePolyfill.js — document start
        if let source = loadBundledScript(named: "ChromePolyfill", ext: "js") {
            let version = extensionManifestVersion() ?? "0.0.0"
            let patched = "var __ffExtensionVersion = '\(version)';\n" + source
            let script = WKUserScript(source: patched, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: world)
            controller.addUserScript(script)
            print("[FeedFilter] Injected ChromePolyfill.js (version \(version))")
        }

        // 2. background-app.js — document start (IIFE bundle)
        if let source = loadBundledScript(named: "background-app", ext: "js", subdirectory: "dist") {
            let script = WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: world)
            controller.addUserScript(script)
            print("[FeedFilter] Injected background-app.js")
        }

        // 3. Popup bridge — document start
        if let source = buildPopupBridgeScript() {
            let script = WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: world)
            controller.addUserScript(script)
            print("[FeedFilter] Injected PopupBridge")
        }

        // 4. dompurify.js — document end
        if let source = loadBundledScript(named: "dompurify", ext: "js") {
            let script = WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: world)
            controller.addUserScript(script)
            print("[FeedFilter] Injected dompurify.js")
        }

        // 5. Platform adapters — document end. All are injected on every page;
        // each self-guards by hostname (see the adapter files), claiming
        // `window.BouncerAdapter` only on its own site, so content.js picks the
        // right one based on current location. Registry-driven so adding a
        // platform here is one entry in Platforms.swift.
        for platform in Platforms.all {
            guard let source = loadBundledScript(
                named: platform.adapterScriptName, ext: "js", subdirectory: "dist"
            ) else { continue }
            let script = WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: world)
            controller.addUserScript(script)
            print("[FeedFilter] Injected \(platform.adapterScriptName).js")
        }

        // 6. content.js — document end (bundled IIFE from dist/)
        if let source = loadBundledScript(named: "content", ext: "js", subdirectory: "dist") {
            let script = WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: world)
            controller.addUserScript(script)
            print("[FeedFilter] Injected content.js")
        }

        // 7. CSS injection — document end (in page world)
        if let cssScript = buildCSSInjectionScript() {
            let script = WKUserScript(source: cssScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
            controller.addUserScript(script)
            print("[FeedFilter] Injected CSS styles")
        }

        // 8. App install prompt bypass — redirect to x.com when Twitter shows the "get the app" screen
        let bypassScript = WKUserScript(source: """
            (function() {
                var re = /The X app lets you see what.s happening, join the conversation, and watch live events, instantly\\./;
                function check() {
                    if (document.body && re.test(document.body.innerText)) {
                        window.location.href = "https://x.com";
                    }
                }
                var observer = new MutationObserver(check);
                observer.observe(document.documentElement, { childList: true, subtree: true });
                check();
            })();
            """, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        controller.addUserScript(bypassScript)
        print("[FeedFilter] Injected app-install bypass")
    }

    // MARK: - Popup Bridge

    private func buildPopupBridgeScript() -> String? {
        guard let popupCSS = loadBundledScript(named: "popup", ext: "css"),
              let popupJS = loadBundledScript(named: "popup-app", ext: "js", subdirectory: "dist") else {
            print("[FeedFilter] Failed to load popup resources for bridge")
            return nil
        }

        guard let popupHTML = loadBundledScript(named: "popup", ext: "html"),
              let bodyStart = popupHTML.range(of: "<body>"),
              let bodyEnd = popupHTML.range(of: "</body>") else {
            print("[FeedFilter] Failed to parse popup.html")
            return nil
        }
        let bodyContent = String(popupHTML[bodyStart.upperBound..<bodyEnd.lowerBound])
            .replacingOccurrences(of: "<script src=\"browser-polyfill.js\"></script>", with: "")
            .replacingOccurrences(of: "<script src=\"dist/popup.js\" type=\"module\"></script>", with: "")

        let patchedPopupJS = popupJS.replacingOccurrences(
            of: "document.addEventListener(\"DOMContentLoaded\", init);",
            with: "init();"
        )

        guard let cssB64 = popupCSS.data(using: .utf8)?.base64EncodedString(),
              let htmlB64 = bodyContent.data(using: .utf8)?.base64EncodedString(),
              let jsB64 = patchedPopupJS.data(using: .utf8)?.base64EncodedString() else {
            return nil
        }

        return """
        (function() {
            function b64(s) { return decodeURIComponent(escape(atob(s))); }
            window.__feedfilterPopup = {
                css: b64('\(cssB64)'),
                html: b64('\(htmlB64)'),
                js: b64('\(jsB64)')
            };
            console.log('[FeedFilter] PopupBridge: popup resources loaded');
        })();
        """
    }

    // MARK: - Script Loading Helpers

    private func loadBundledScript(named name: String, ext: String, subdirectory: String? = nil) -> String? {
        let url: URL?
        if let subdirectory = subdirectory {
            url = Bundle.main.url(forResource: name, withExtension: ext, subdirectory: subdirectory)
        } else {
            url = Bundle.main.url(forResource: name, withExtension: ext)
        }
        guard let fileURL = url else {
            print("[FeedFilter] Failed to find bundled script: \(subdirectory ?? "")/\(name).\(ext)")
            return nil
        }
        return try? String(contentsOf: fileURL, encoding: .utf8)
    }

    private func buildCSSInjectionScript() -> String? {
        var cssContent = ""

        if let contentCSS = loadBundledScript(named: "content", ext: "css") {
            cssContent += contentCSS
        }
        // Platform stylesheets — registry-driven so adding a platform here
        // is one entry in Platforms.swift.
        for platform in Platforms.all {
            if let css = loadBundledScript(named: platform.cssFile, ext: "css", subdirectory: platform.cssSubdir) {
                cssContent += "\n" + css
            }
        }

        guard !cssContent.isEmpty else { return nil }

        let escaped = cssContent
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "`", with: "\\`")
            .replacingOccurrences(of: "$", with: "\\$")

        return """
        (function() {
            var style = document.createElement('style');
            style.textContent = `\(escaped)`;
            document.head.appendChild(style);
        })();
        """
    }

    private func extensionManifestVersion() -> String? {
        guard let manifestURL = Bundle.main.url(forResource: "manifest", withExtension: "json"),
              let data = try? Data(contentsOf: manifestURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = json["version"] as? String else { return nil }
        return version
    }

    // MARK: - Local-classify resolver

    // Calls window.__ff_resolveLocalClassify(callbackId, ok, b64Payload). The
    // payload is base64-encoded so JS strings with quotes/newlines round-trip
    // safely through evaluateJavaScript.
    static func resolveLocalClassify(webView: WKWebView?, callbackId: String, ok: Bool, payload: String) async {
        guard let webView = webView else { return }
        let b64 = Data(payload.utf8).base64EncodedString()
        let escapedId = callbackId.replacingOccurrences(of: "'", with: "\\'")
        let js = "window.__ff_resolveLocalClassify('\(escapedId)', \(ok ? "true" : "false"), '\(b64)');"
        await webView.evaluateJavaScript(js, in: nil, in: FilteredWebView.extensionWorld)
    }

    // Calls window.__ff_resolveLocalAiTextDetect(callbackId, ok, b64Payload).
    // Payload is the same base64-encoded JSON convention as the classify
    // bridge above. On success the JSON is
    //     {"logits": [f,f,f,f], "aiConfidence": f}
    // where aiConfidence is the normalized expected bucket index:
    //     aiConfidence = (softmax(logits) · [0, 1, 2, 3]) / 3
    // matching the EditLens training-pipeline scoring formula
    //     (probs @ arange(n_buckets)) / (n_buckets - 1).
    // Ranges in [0, 1]: 0 = clearly human, 1 = clearly AI. On error the
    // payload is a string error message.
    static func resolveLocalAiTextDetect(webView: WKWebView?, callbackId: String, ok: Bool, payload: String) async {
        guard let webView = webView else { return }
        let b64 = Data(payload.utf8).base64EncodedString()
        let escapedId = callbackId.replacingOccurrences(of: "'", with: "\\'")
        let js = "window.__ff_resolveLocalAiTextDetect('\(escapedId)', \(ok ? "true" : "false"), '\(b64)');"
        await webView.evaluateJavaScript(js, in: nil, in: FilteredWebView.extensionWorld)
    }

    // MARK: - Coordinator

    class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply, UIAdaptivePresentationControllerDelegate {

        let sheetViewModel: FilterSheetViewModel

        init(sheetViewModel: FilterSheetViewModel) {
            self.sheetViewModel = sheetViewModel
            super.init()
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            if message.name == "feedfilterLog" {
                print("[FeedFilter JS] \(message.body)")
                return
            }

            if message.name == "feedfilterModalClosed" {
                DispatchQueue.main.async { [weak self] in
                    self?.sheetViewModel.isFilteredModalOpen = false
                }
                return
            }

            if message.name == "feedfilterGetAppCheckToken" {
                // JS sends a callbackId so we can resolve the correct Promise
                guard let callbackId = message.body as? String else { return }
                let webView = message.webView
                Task {
                    let token = await AppCheckBridge.shared.getToken() ?? ""
                    let escaped = token.replacingOccurrences(of: "'", with: "\\'")
                    let js = "window.__ff_resolveAppCheckToken('\(callbackId)', '\(escaped)');"
                    await webView?.evaluateJavaScript(js, in: nil, in: FilteredWebView.extensionWorld)
                }
                return
            }

            if message.name == "feedfilterLocalClassify" {
                guard let jsonString = message.body as? String,
                      let data = jsonString.data(using: .utf8),
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let callbackId = json["callbackId"] as? String,
                      let systemMessage = json["systemMessage"] as? String,
                      let userMessage = json["userMessage"] as? String else {
                    print("[FeedFilter] Failed to parse feedfilterLocalClassify payload")
                    return
                }
                let imageUrls = (json["imageUrls"] as? [String]) ?? []
                let regexConstraint = json["regexConstraint"] as? String
                let webView = message.webView
                let tweetStart = Date()
                Task { @MainActor in
                    do {
                        let response = try await LocalInferenceService.shared.classify(
                            systemMessage: systemMessage,
                            userMessage: userMessage,
                            imageUrls: imageUrls,
                            regexConstraint: regexConstraint
                        )
                        let elapsed = Date().timeIntervalSince(tweetStart)
                        print(String(
                            format: "[Tweet] processed cb=%@ in %.2fs ok userLen=%d imgs=%d",
                            callbackId, elapsed, userMessage.count, imageUrls.count
                        ))
                        await FilteredWebView.resolveLocalClassify(webView: webView, callbackId: callbackId, ok: true, payload: response)
                    } catch {
                        let nsError = error as NSError
                        let payload = "\(type(of: error))[\(nsError.domain)#\(nsError.code)]: \(error.localizedDescription) | images=\(imageUrls.count) sysLen=\(systemMessage.count) userLen=\(userMessage.count)"
                        let elapsed = Date().timeIntervalSince(tweetStart)
                        print(String(
                            format: "[Tweet] processed cb=%@ in %.2fs err userLen=%d imgs=%d",
                            callbackId, elapsed, userMessage.count, imageUrls.count
                        ))
                        print("[FeedFilter] classify error → JS: \(payload)")
                        await FilteredWebView.resolveLocalClassify(webView: webView, callbackId: callbackId, ok: false, payload: payload)
                    }
                }
                return
            }

            if message.name == "feedfilterLocalAiTextDetect" {
                guard let jsonString = message.body as? String,
                      let data = jsonString.data(using: .utf8),
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let callbackId = json["callbackId"] as? String,
                      let text = json["text"] as? String else {
                    print("[FeedFilter] Failed to parse feedfilterLocalAiTextDetect payload")
                    return
                }
                let webView = message.webView
                Task { @MainActor in
                    do {
                        let logits = try await LocalInferenceService.shared.classifyText(text)
                        let confidence = LocalInferenceService.aiConfidence(fromLogits: logits)
                        let responseJson: [String: Any] = [
                            "logits": logits.map { Double($0) },
                            "aiConfidence": Double(confidence),
                        ]
                        let payloadData = try JSONSerialization.data(withJSONObject: responseJson)
                        let payload = String(data: payloadData, encoding: .utf8) ?? "{}"
                        await FilteredWebView.resolveLocalAiTextDetect(
                            webView: webView, callbackId: callbackId, ok: true, payload: payload)
                    } catch {
                        let nsError = error as NSError
                        let payload = "\(type(of: error))[\(nsError.domain)#\(nsError.code)]: \(error.localizedDescription) | textLen=\(text.count)"
                        print("[FeedFilter] classifyText error → JS: \(payload)")
                        await FilteredWebView.resolveLocalAiTextDetect(
                            webView: webView, callbackId: callbackId, ok: false, payload: payload)
                    }
                }
                return
            }

            if message.name == "feedfilterWsOpen" || message.name == "feedfilterWsSend" || message.name == "feedfilterWsClose" {
                guard let jsonString = message.body as? String,
                      let data = jsonString.data(using: .utf8),
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let socketId = json["socketId"] as? String else {
                    print("[FeedFilter] Failed to parse WebSocket message: \(message.name)")
                    return
                }

                if message.name == "feedfilterWsOpen" {
                    let url = json["url"] as? String ?? ""
                    print("[FeedFilter] WS open: \(socketId) -> \(url)")
                    WebSocketBridge.shared.open(socketId: socketId, urlString: url)
                } else if message.name == "feedfilterWsSend" {
                    let payload = json["data"] as? String ?? ""
                    WebSocketBridge.shared.send(socketId: socketId, data: payload)
                } else if message.name == "feedfilterWsClose" {
                    WebSocketBridge.shared.close(socketId: socketId)
                }
                return
            }

            if message.name == "feedfilterShowSheet" || message.name == "feedfilterPhrasesUpdated" {
                guard let jsonString = message.body as? String,
                      let data = jsonString.data(using: .utf8),
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    print("[FeedFilter] Failed to parse message body for \(message.name)")
                    return
                }

                DispatchQueue.main.async { [weak self] in
                    guard let vm = self?.sheetViewModel else { return }

                    // Phrase list is driven by the sheet's platform dropdown
                    // (viewModel.loadPhrases), not this push — the push carries
                    // only the current site's phrases and would clobber a
                    // cross-platform view. We still take the filtered count.
                    if let count = json["filteredCount"] as? Int {
                        vm.filteredCount = count
                    }
                    if let theme = json["theme"] as? String {
                        vm.themeMode = theme
                    }

                    if message.name == "feedfilterShowSheet" {
                        vm.isPresented.toggle()
                    }
                }
                return
            }
        }

        // MARK: - Storage bridge (chrome.storage backing)

        // Origin-independent store backing chrome.storage.local/sync for the
        // WKWebView. Lives in UserDefaults (native, app-wide) so x.com and
        // m.youtube.com share the same settings/keys — only the per-platform
        // `descriptions_<site>` keys differ, by name. Values are stored as the
        // raw JSON strings the JS polyfill sends, keyed by "ffstore_" + the
        // polyfill's prefix ("ff_local_"/"ff_sync_") + key.
        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage,
            replyHandler: @escaping (Any?, String?) -> Void
        ) {
            guard message.name == "feedfilterStorage",
                  let body = message.body as? [String: Any],
                  let op = body["op"] as? String,
                  let prefix = body["prefix"] as? String else {
                replyHandler(nil, "feedfilterStorage: malformed request")
                return
            }

            let defaults = UserDefaults.standard
            let storePrefix = "ffstore_" + prefix
            func storeKey(_ key: String) -> String { storePrefix + key }

            switch op {
            case "get":
                let keys = body["keys"] as? [String] ?? []
                var out: [String: Any] = [:]
                for k in keys {
                    if let v = defaults.string(forKey: storeKey(k)) { out[k] = v }
                }
                replyHandler(out, nil)

            case "getAll":
                var out: [String: Any] = [:]
                for (fullKey, value) in defaults.dictionaryRepresentation() where fullKey.hasPrefix(storePrefix) {
                    if let v = value as? String { out[String(fullKey.dropFirst(storePrefix.count))] = v }
                }
                replyHandler(out, nil)

            case "set":
                let items = body["items"] as? [String: String] ?? [:]
                var old: [String: Any] = [:]
                for (k, v) in items {
                    if let prev = defaults.string(forKey: storeKey(k)) { old[k] = prev }
                    defaults.set(v, forKey: storeKey(k))
                }
                replyHandler(old, nil)

            case "remove":
                let keys = body["keys"] as? [String] ?? []
                var old: [String: Any] = [:]
                for k in keys {
                    if let prev = defaults.string(forKey: storeKey(k)) { old[k] = prev }
                    defaults.removeObject(forKey: storeKey(k))
                }
                replyHandler(old, nil)

            default:
                replyHandler(nil, "feedfilterStorage: unknown op \(op)")
            }
        }

        // MARK: - Navigation

        private var canGoBackObservation: NSKeyValueObservation?
        private var canGoForwardObservation: NSKeyValueObservation?
        private var urlObservation: NSKeyValueObservation?

        func observeWebView(_ webView: WKWebView) {
            canGoBackObservation = webView.observe(\.canGoBack, options: [.initial, .new]) { [weak self] wv, _ in
                DispatchQueue.main.async {
                    self?.sheetViewModel.canGoBack = wv.canGoBack
                }
            }
            canGoForwardObservation = webView.observe(\.canGoForward, options: [.initial, .new]) { [weak self] wv, _ in
                DispatchQueue.main.async {
                    self?.sheetViewModel.canGoForward = wv.canGoForward
                }
            }
            urlObservation = webView.observe(\.url, options: [.initial, .new]) { [weak self] wv, _ in
                DispatchQueue.main.async {
                    self?.sheetViewModel.currentURL = wv.url?.absoluteString ?? ""
                }
            }
        }

        // Platform-owned hosts come from the registry; system/auth hosts are
        // hand-listed because they're shared across platforms (Google sign-in,
        // Apple ID) and don't belong to any one platform.
        private let allowedHosts: Set<String> = Set(
            Platforms.allHostRoots + [
                "accounts.google.com", "google.com", "gstatic.com",
                "apple.com", "appleid.apple.com",
            ]
        )

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url, let host = url.host?.lowercased() else {
                decisionHandler(.allow)
                return
            }

            let isAllowed = allowedHosts.contains(where: { host == $0 || host.hasSuffix(".\($0)") })

            // If the auth popup tries to navigate to x.com, the flow is done — dismiss it
            if webView === popupWebView && (host == "x.com" || host.hasSuffix(".x.com") || host == "twitter.com" || host.hasSuffix(".twitter.com")) {
                decisionHandler(.cancel)
                dismissPopup()
                return
            }

            if isAllowed {
                decisionHandler(.allow)
            } else if navigationAction.navigationType == .linkActivated {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
        }

        private weak var popupWebView: WKWebView?
        private weak var popupViewController: UIViewController?

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            guard let url = navigationAction.request.url, let host = url.host?.lowercased() else {
                // No URL — fall back to loading in the main webView
                if let url = navigationAction.request.url {
                    webView.load(URLRequest(url: url))
                }
                return nil
            }

            // Auth popups need a real child WKWebView so they can postMessage back to the opener
            let isAuthPopup = host == "appleid.apple.com" || host.hasSuffix(".appleid.apple.com")
                || host == "accounts.google.com" || host.hasSuffix(".accounts.google.com")

            guard isAuthPopup else {
                // For everything else (target="_blank" links), load inline
                webView.load(URLRequest(url: url))
                return nil
            }

            // Create a child WKWebView using the provided configuration (shares session)
            let popup = WKWebView(frame: .zero, configuration: configuration)
            popup.customUserAgent = webView.customUserAgent
            popup.navigationDelegate = self
            popup.uiDelegate = self
            if #available(iOS 16.4, *) {
                popup.isInspectable = true
            }
            popupWebView = popup

            // Present in a native iOS sheet with a nav bar and Cancel button
            let vc = UIViewController()
            vc.view = popup
            let nav = UINavigationController(rootViewController: vc)
            nav.modalPresentationStyle = .pageSheet
            nav.presentationController?.delegate = self

            vc.navigationItem.title = "Sign In"
            vc.navigationItem.leftBarButtonItem = UIBarButtonItem(
                barButtonSystemItem: .cancel,
                target: self,
                action: #selector(popupCancelTapped)
            )

            guard let presentingVC = webView.findViewController() else { return popup }
            presentingVC.present(nav, animated: true)
            popupViewController = nav

            return popup
        }

        @objc private func popupCancelTapped() {
            dismissPopup()
        }

        /// Called when JS calls `window.close()` on the popup
        func webViewDidClose(_ webView: WKWebView) {
            guard webView === popupWebView else { return }
            dismissPopup()
        }

        private func dismissPopup() {
            popupWebView = nil
            if let vc = popupViewController {
                vc.dismiss(animated: true)
                popupViewController = nil
            }
        }

        // MARK: - UIAdaptivePresentationControllerDelegate

        /// Called when the user swipes the sheet down to dismiss
        func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
            popupWebView = nil
            popupViewController = nil
        }
    }
}

// MARK: - UIView helper

extension UIView {
    func findViewController() -> UIViewController? {
        var responder: UIResponder? = self
        while let next = responder?.next {
            if let vc = next as? UIViewController { return vc }
            responder = next
        }
        return nil
    }
}
