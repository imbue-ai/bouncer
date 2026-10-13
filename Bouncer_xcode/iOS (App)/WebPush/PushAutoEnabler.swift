//
//  PushAutoEnabler.swift
//  iOS (App)
//
//  Silent x.com push auto-enable — the iOS port of Android's
//  BouncerViewModel.maybeAutoEnablePush / startBackgroundPushEnable.
//
//  Turn on x.com push notifications with zero UI, once per install: when the
//  user reaches the authenticated home timeline (or flips the settings
//  toggle), load x.com's push-settings page in a HIDDEN web view (same cookie
//  store, so already logged in), wait for its toggle to render, and have
//  PushAutoEnable.js click it. x.com's own change handler then does both
//  halves that matter — pushManager.subscribe() (answered by WebPushPolyfill →
//  WebPushBridge → PushRegistrar, which gets the Mozilla endpoint from the
//  relay) AND the POST that registers the subscription with x.com's backend.
//  PushRegistrar.onSubscriptionRegistered is the "it worked" signal; the view
//  is kept alive a few seconds longer so that POST completes, then torn down.
//
//  The only thing the user ever sees is the iOS notification-permission
//  prompt, which we can't self-grant and which gates delivery anyway; it is
//  normally shown at onboarding (PushRegistrar.requestAuthorizationEarly).
//

import Foundation
import UIKit
import UserNotifications
import WebKit

final class PushAutoEnabler: NSObject, WKScriptMessageHandler {
    static let shared = PushAutoEnabler()
    static let handlerName = "bouncerPushAutoEnable"
    /// Posted (on main) whenever the subscription state may have changed, so
    /// the settings toggle can re-read it.
    static let stateChangedNotification = Notification.Name("BouncerPushStateChanged")

    private static let settingsURL = URL(string: "https://x.com/settings/push_notifications")!
    // Same budgets as Android: a hidden page renders slowly, but it's
    // invisible, so we wait a long time for the toggle; the subscribe after
    // the click is quick; x.com's backend POST needs a few seconds more.
    private static let toggleRenderTimeout: TimeInterval = 90
    private static let subscribeTimeout: TimeInterval = 15
    private static let registerGrace: TimeInterval = 6

    // Once-per-session evaluation of the silent attempt (persisted intent and
    // subscription state do the cross-launch gating).
    private var evaluated = false
    private var hiddenView: WKWebView?
    private var timeoutTask: Task<Void, Never>?
    private var completion: ((Bool) -> Void)?
    private var awaitingSubscription = false
    private var secondClickPending = false
    // Set when backgrounding cut an attempt short; retried on foreground.
    private var interrupted = false
    private weak var lastCoordinator: FilteredWebView.WebCoordinator?

    private override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self, selector: #selector(appDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    // MARK: - Triggers

    /// Called on every URL change of the visible web view. Reaching x.com's
    /// home timeline is proof of login, and the cue for the silent attempt.
    func onURLChanged(_ url: String, coordinator: FilteredWebView.WebCoordinator) {
        guard Self.isHome(url) else { return }
        maybeAutoEnable(coordinator: coordinator)
    }

    private func maybeAutoEnable(coordinator: FilteredWebView.WebCoordinator) {
        guard !evaluated else { return }
        evaluated = true
        if PushRegistrar.userOptedOut {
            print("[WebPush] auto-enable: user turned notifications off; skipping")
            return
        }
        if PushRegistrar.shared.isSubscribedToX {
            print("[WebPush] auto-enable: already subscribed")
            return
        }
        guard PushRelayClient.isConfigured else {
            print("[WebPush] auto-enable: relay not configured; skipping")
            return
        }
        Task { @MainActor in
            let center = UNUserNotificationCenter.current()
            let settings = await center.notificationSettings()
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                // Typically granted at onboarding → no dialog, just proceed.
                self.start(coordinator: coordinator, completion: nil)
            case .notDetermined:
                // Never asked (onboarded before this feature): ask now as the
                // fallback, proceed on grant.
                guard !UserDefaults.standard.bool(forKey: PushRegistrar.notificationsPromptedKey) else { return }
                let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
                UserDefaults.standard.set(true, forKey: PushRegistrar.notificationsPromptedKey)
                print("[WebPush] auto-enable: permission (timeline fallback) granted=\(granted)")
                if granted { self.start(coordinator: coordinator, completion: nil) }
            default:
                print("[WebPush] auto-enable: notifications denied in Settings; skipping")
                debugNotify("Notifications denied in iOS Settings")
            }
        }
    }

    /// The settings toggle turned on while unsubscribed: run the same flow,
    /// asking for permission first if needed. `completion(false)` lets the
    /// toggle fall back to off.
    func enableFromSettings(coordinator: FilteredWebView.WebCoordinator, completion: @escaping (Bool) -> Void) {
        if PushRegistrar.shared.isSubscribedToX {
            completion(true)
            return
        }
        Task { @MainActor in
            let center = UNUserNotificationCenter.current()
            let settings = await center.notificationSettings()
            var allowed: Bool
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                allowed = true
            case .notDetermined:
                allowed = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
                UserDefaults.standard.set(true, forKey: PushRegistrar.notificationsPromptedKey)
            default:
                allowed = false
            }
            guard allowed else {
                print("[WebPush] enable from settings: notifications not authorized")
                debugNotify("Notifications need permission in iOS Settings")
                completion(false)
                return
            }
            self.start(coordinator: coordinator, completion: completion)
        }
    }

    /// Foreground: an attempt interrupted by backgrounding gets another go.
    func retryIfNeeded() {
        guard interrupted, let coordinator = lastCoordinator else { return }
        interrupted = false
        guard !PushRegistrar.userOptedOut, !PushRegistrar.shared.isSubscribedToX else { return }
        print("[WebPush] auto-enable: retrying after foreground")
        start(coordinator: coordinator, completion: nil)
    }

    // MARK: - The hidden settings view

    private func start(coordinator: FilteredWebView.WebCoordinator, completion: ((Bool) -> Void)?) {
        if hiddenView != nil {
            // Already in flight; the newest caller rides along.
            if let completion { self.completion = completion }
            return
        }
        guard let window = Self.keyWindow() else {
            print("[WebPush] auto-enable: no window to attach the hidden view to")
            completion?(false)
            return
        }
        lastCoordinator = coordinator
        self.completion = completion

        // Same cookie store (logged in), same user agent (same x.com client),
        // the Push API polyfill with its native answerer (the page's
        // subscribe() lands in WebPushBridge exactly as on the main view), and
        // our driver script.
        let ucc = WKUserContentController()
        ucc.addScriptMessageHandler(coordinator, contentWorld: .page, name: WebPushBridge.handlerName)
        ucc.add(self, contentWorld: .page, name: Self.handlerName)
        if let source = Self.bundledScript("WebPushPolyfill") {
            ucc.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        }
        if let source = Self.bundledScript("PushAutoEnable") {
            ucc.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .page))
        }
        let config = WKWebViewConfiguration()
        config.userContentController = ucc
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true

        // Full-size so x.com lays out normally, translated far off the right
        // edge so it's never visible; attached to the window so WebKit treats
        // it as a live page rather than throttling it as hidden.
        let view = WKWebView(frame: window.bounds, configuration: config)
        view.customUserAgent = FilteredWebView.WebViewFactory.userAgent()
        if #available(iOS 16.4, *) { view.isInspectable = true }
        view.transform = CGAffineTransform(translationX: 100_000, y: 0)
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
        window.addSubview(view)
        hiddenView = view
        awaitingSubscription = false
        secondClickPending = false

        PushRegistrar.shared.onSubscriptionRegistered = { [weak self] scope in self?.onSubscribed(scope) }
        print("[WebPush] auto-enable: loading hidden settings view")
        view.load(URLRequest(url: Self.settingsURL))
        armTimeout(Self.toggleRenderTimeout, reason: "toggle never rendered")
    }

    // MARK: - Messages from PushAutoEnable.js

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.handlerName,
              let body = message.body as? [String: Any],
              let event = body["event"] as? String else { return }
        switch event {
        case "ready":
            timeoutTask?.cancel()
            let checked = (body["checked"] as? Bool) ?? false
            print("[WebPush] auto-enable: toggle ready (checked=\(checked), \(body["elapsedMs"] ?? 0)ms)")
            if checked && PushRegistrar.shared.isSubscribedToX {
                debugNotify("Notifications already on ✓")
                finish(ok: true, reason: "already on")
                return
            }
            // Off → one click subscribes. On without a local subscription
            // (e.g. after a reinstall x.com still holds a dead endpoint) → the
            // first click turns it off; a second one re-subscribes.
            secondClickPending = checked
            awaitingSubscription = !checked
            click()
            armTimeout(checked ? Self.subscribeTimeout + 5 : Self.subscribeTimeout, reason: "no subscription after click")

        case "click":
            if (body["ok"] as? Bool) != true {
                fail("click failed: \(body["reason"] ?? "?")")
            }

        case "after-click":
            let checked = (body["checked"] as? Bool) ?? false
            print("[WebPush] auto-enable: after click, toggle checked=\(checked)")
            if secondClickPending && !checked {
                secondClickPending = false
                awaitingSubscription = true
                click()
            }

        case "timeout":
            fail("toggle never rendered")

        case "waiting":
            print("[WebPush] auto-enable: waiting for toggle (\(body["elapsedMs"] ?? 0)ms, inputs=\(body["inputs"] ?? 0))")

        default:
            break
        }
    }

    private func click() {
        hiddenView?.evaluateJavaScript("window.__bouncerAutoEnableClick && window.__bouncerAutoEnableClick(); 0", in: nil, in: .page) { _ in }
    }

    private func onSubscribed(_ scope: String) {
        guard awaitingSubscription, scope == PushRegistrar.xScope else { return }
        awaitingSubscription = false
        timeoutTask?.cancel()
        PushRegistrar.setNotificationsOn(true)
        NotificationCenter.default.post(name: Self.stateChangedNotification, object: nil)
        print("[WebPush] auto-enable: subscription registered; letting x.com's backend POST finish")
        debugNotify("Notifications enabled ✓")
        // The browser subscribe() has resolved, but x.com now POSTs that
        // subscription to its own backend; closing the view immediately would
        // abort that and the toggle would read "off" everywhere.
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(Self.registerGrace * 1_000_000_000))
            self.finish(ok: true, reason: "subscribed")
        }
    }

    // MARK: - Lifecycle

    private func armTimeout(_ seconds: TimeInterval, reason: String) {
        timeoutTask?.cancel()
        timeoutTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self.fail(reason)
        }
    }

    private func fail(_ reason: String) {
        print("[WebPush] auto-enable failed: \(reason)")
        debugNotify("Notification setup failed (\(reason))")
        finish(ok: false, reason: reason)
    }

    private func finish(ok: Bool, reason: String) {
        guard hiddenView != nil else { return }
        print("[WebPush] auto-enable finished: ok=\(ok) (\(reason))")
        teardown()
        let done = completion
        completion = nil
        done?(ok)
        NotificationCenter.default.post(name: Self.stateChangedNotification, object: nil)
    }

    private func teardown() {
        timeoutTask?.cancel()
        timeoutTask = nil
        PushRegistrar.shared.onSubscriptionRegistered = nil
        awaitingSubscription = false
        secondClickPending = false
        if let view = hiddenView {
            view.stopLoading()
            view.configuration.userContentController.removeAllScriptMessageHandlers()
            view.removeFromSuperview()
        }
        hiddenView = nil
    }

    @objc private func appDidEnterBackground() {
        // WebKit suspends the hidden page with the app; rather than let the
        // attempt time out against a frozen view, drop it and retry on return.
        guard hiddenView != nil else { return }
        print("[WebPush] auto-enable: backgrounded mid-flight; will retry on foreground")
        interrupted = true
        let done = completion
        completion = nil
        teardown()
        done?(false)
    }

    // MARK: - Helpers

    /// Debug-only, transient confirmation while testing the silent auto-enable
    /// — the iOS stand-in for Android's debugToast. A local notification
    /// banner (shown in-app too, via the delegate's willPresent). No-op in
    /// release builds.
    private func debugNotify(_ message: String) {
        #if DEBUG
        let content = UNMutableNotificationContent()
        content.title = "Bouncer (debug)"
        content.body = message
        // Default (active) level: passive would skip the banner entirely and
        // only land in Notification Center.
        let request = UNNotificationRequest(identifier: "bouncer-debug-\(UUID().uuidString)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error { print("[WebPush] debug notification failed: \(error)") }
        }
        #endif
    }

    private static func isHome(_ url: String) -> Bool {
        url.contains("x.com/home") || url.contains("twitter.com/home")
    }

    private static func keyWindow() -> UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }
    }

    private static func bundledScript(_ name: String) -> String? {
        guard let url = Bundle.main.url(forResource: name, withExtension: "js") else {
            print("[WebPush] auto-enable: \(name).js not bundled")
            return nil
        }
        return try? String(contentsOf: url, encoding: .utf8)
    }
}
