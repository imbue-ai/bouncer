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
