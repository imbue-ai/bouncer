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

        let hasLoggedIn = UserDefaults.standard.bool(forKey: "hasLoggedIn")
        let urlString = hasLoggedIn ? "https://x.com" : "https://x.com/i/flow/login"
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

        // 5. TwitterAdapter.js — document end
        if let source = loadBundledScript(named: "TwitterAdapter", ext: "js", subdirectory: "dist") {
            let script = WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: world)
            controller.addUserScript(script)
            print("[FeedFilter] Injected TwitterAdapter.js")
        }

        // 5b. fiber-extractor.js — document end, page main world. Must run in
        // the page's world (not `feedfilter`) so it can read X's React fiber
        // refs (`__reactFiber$…`) and the Redux store off DOM nodes — those
        // properties are world-scoped JS state, not DOM. Communicates with
        // TwitterAdapter (in `feedfilter`) via document-level CustomEvents,
        // which cross WKContentWorld boundaries because they're DOM events.
        if let source = loadBundledScript(named: "fiber-extractor", ext: "js", subdirectory: "adapters/twitter") {
            let script = WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .page)
            controller.addUserScript(script)
            print("[FeedFilter] Injected fiber-extractor.js (page world)")
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
        if let twitterCSS = loadBundledScript(named: "twitter", ext: "css", subdirectory: "adapters/twitter") {
            cssContent += "\n" + twitterCSS
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

    // MARK: - Coordinator

    class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UIAdaptivePresentationControllerDelegate {

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

                    if let phrases = json["phrases"] as? [String] {
                        vm.phrases = phrases
                    }
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

        private let allowedHosts: Set<String> = [
            "x.com", "twitter.com", "t.co", "twimg.com", "pbs.twimg.com", "abs.twimg.com", "video.twimg.com",
            "accounts.google.com", "accounts.youtube.com", "google.com", "gstatic.com",
            "apple.com", "appleid.apple.com",
        ]

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
