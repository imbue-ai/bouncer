//
//  SceneDelegate.swift
//  iOS (App)
//
//  Created by Darren Jia on 2/12/26.
//

import UIKit
import SwiftUI
import WebKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = (scene as? UIWindowScene) else { return }

        // Prewarm WebKit's WebContent process. The very first WKWebView in
        // a process triggers a fork/exec of com.apple.WebKit.WebContent —
        // 100-300ms of latency that would otherwise land on the user's
        // first platform pick and stall the NavigationStack push animation
        // that runs concurrently. Doing it here means it happens while
        // iOS's launch screen is still on-screen, invisibly. Subsequent
        // WKWebViews (real ones built by WebViewFactory) reuse the warm
        // process and are much cheaper to instantiate.
        _prewarmWebKit()

        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = UIHostingController(rootView: FilteredWebViewContainer())
        window.makeKeyAndVisible()
        self.window = window

        // A widget tap on a cold launch arrives here rather than through
        // `openURLContexts` — that one is only called on a scene that already
        // exists. Handled after the window is built so the route has somewhere
        // to land; GateRouter holds it either way, and the container consumes
        // it on appear.
        connectionOptions.urlContexts.forEach { handle(url: $0.url) }
    }

    /// A widget tap on an already-running scene.
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        URLContexts.forEach { handle(url: $0.url) }
    }

    /// `bouncer://platform/<id>` — the only URL we answer, posted by the
    /// home-screen tiles in BouncerWidgets.
    ///
    /// The route rides GateRouter rather than a second mechanism of its own.
    /// It is already the thing that carries "open this platform" from outside
    /// the app to FilteredWebViewContainer, and a widget tap and a shield's
    /// handoff are the same request arriving by different roads.
    private func handle(url: URL) {
        guard url.scheme == "bouncer", url.host == "platform" else { return }
        let id = url.lastPathComponent
        guard !id.isEmpty, id != "/" else { return }

        if Platforms.byId(id) != nil {
            Task { @MainActor in GateRouter.shared.route(to: id) }
        } else {
            // A tile for a platform Bouncer does not carry — Instagram, today.
            // There is no feed of ours to open, so the honest answer is the
            // real app, which is where the gate's shield is waiting anyway.
            openRealApp(for: id)
        }
    }

    /// Hand off to the platform's own app, falling back to the web when it is
    /// not installed.
    ///
    /// `open(_:options:completionHandler:)` reports whether it worked, which is
    /// why there is no `canOpenURL` here: that call needs the scheme declared
    /// in LSApplicationQueriesSchemes, and asking-then-opening is two ways to
    /// get the same answer.
    private func openRealApp(for id: String) {
        let schemes: [String: (app: String, web: String)] = [
            "instagram": ("instagram://app", "https://www.instagram.com/"),
        ]
        guard let destination = schemes[id] else { return }
        guard let appURL = URL(string: destination.app),
              let webURL = URL(string: destination.web) else { return }

        UIApplication.shared.open(appURL, options: [:]) { opened in
            guard !opened else { return }
            UIApplication.shared.open(webURL)
        }
    }

    private func _prewarmWebKit() {
        // A bare WKWebView is enough to force WebContent-process launch;
        // nothing needs to be loaded. Immediately released after this
        // scope ends — WebKit keeps the underlying process alive for a
        // short window so the next WKWebView reuses it.
        _ = WKWebView(frame: .zero)
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        // Catch up to anything the background URLSession did while we
        // were suspended: completed downloads, persisted pauses, etc.
        LocalInferenceService.shared.reconcileDownload()
    }
}
