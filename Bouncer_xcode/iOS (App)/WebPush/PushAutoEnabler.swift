//
//  PushAutoEnabler.swift
//  iOS (App)
//
//  Silent push auto-enable for each PushSite (x.com, Facebook) — the iOS port
//  of Android's BouncerViewModel.maybeAutoEnablePush / startBackgroundPushEnable.
//
//  Turn on a site's push notifications with zero UI, once per login: when the
//  user reaches that site's authenticated feed (or flips the settings
//  toggle), load its push-settings page in a HIDDEN web view (same cookie
//  store, so already logged in), wait for its toggle to render, and have
//  PushAutoEnable.js click it. The site's own change handler then does both
//  halves that matter — pushManager.subscribe() (answered by WebPushPolyfill →
//  WebPushBridge → PushRegistrar, which gets the Mozilla endpoint from the
//  relay) AND the POST that registers the subscription with its backend.
//  PushRegistrar.onSubscriptionRegistered is the "it worked" signal; the view
//  is kept alive a few seconds longer so that POST completes, then torn down.
//  One site at a time: another site's attempt queues behind the one in flight.
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

    // Same budgets as Android: a hidden page renders slowly, but it's
    // invisible, so we wait a long time for the toggle; the subscribe after
    // the click is quick; x.com's backend POST needs a few seconds more.
    private static let toggleRenderTimeout: TimeInterval = 90
    private static let subscribeTimeout: TimeInterval = 15
    private static let registerGrace: TimeInterval = 6

    // The silent attempt runs once per login, not per session: each site keeps
    // each account's on/off state server-side, so it only needs checking when
    // the account may have changed. Persisted per site, so a failed attempt
    // (or a login just before the app was killed) is retried at the next
    // launch. Absent = fresh install (or update): check once.
    private static func checkPending(_ site: PushSite) -> Bool {
        UserDefaults.standard.object(forKey: site.checkPendingKey) as? Bool ?? true
    }
    private static func setCheckPending(_ site: PushSite, _ pending: Bool) {
        UserDefaults.standard.set(pending, forKey: site.checkPendingKey)
    }
    // At most one attempt per site per session, so a failing check doesn't loop.
    private var evaluated: Set<PushSite> = []
    // The site the hidden view is working on, and the ones waiting their turn.
    private var site: PushSite?
    private var queue: [PushSite] = []
    // Settings-toggle runs: completion fires once the batch has drained, with
    // whether any site ended up subscribed.
    private var batchSucceeded = false
    private var hiddenView: WKWebView?
    private var timeoutTask: Task<Void, Never>?
    private var completion: ((Bool) -> Void)?
    private var awaitingSubscription = false
    private var secondClickPending = false
    // Sites whose attempt backgrounding cut short; retried on foreground.
    private var interrupted: [PushSite] = []
    // Set when the settings toggle sent the user to iOS Settings to allow
    // notifications; on return with permission granted, enable right away.
    private var awaitingSettingsGrant = false
    // Last-seen OS permission, so a denied → granted change made in iOS
    // Settings (from our prompt or on the user's own) re-arms the attempt.
    private var lastAuthorizationGranted: Bool?
    private weak var lastCoordinator: FilteredWebView.WebCoordinator?
    private var lastURL = ""

    private override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self, selector: #selector(appDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    // MARK: - Triggers

    /// Called on every URL change of the visible web view. Reaching a site's
    /// feed while logged in is the cue for its silent attempt.
    func onURLChanged(_ url: String, coordinator: FilteredWebView.WebCoordinator) {
        lastURL = url
        lastCoordinator = coordinator
        for site in PushSite.allCases where site.isAuthFlow(url) {
            // Login / logout / add-account: the next feed may be a different
            // account, with its own on/off state at the site.
            Self.setCheckPending(site, true)
            evaluated.remove(site)
            return
        }
        guard let site = PushSite.allCases.first(where: { $0.isHome(url) }) else { return }
        maybeAutoEnable(site, coordinator: coordinator)
    }

    // No "already subscribed" shortcut: our subscription is per device, but
    // whether the site sends to it is per account. The hidden page shows the
    // site's own toggle for whoever is logged in, and is only clicked if off.
    private func maybeAutoEnable(_ site: PushSite, coordinator: FilteredWebView.WebCoordinator) {
        guard !evaluated.contains(site), Self.checkPending(site) else { return }
        if PushRegistrar.userOptedOut {
            evaluated.insert(site)
            print("[WebPush] auto-enable: user turned notifications off; skipping")
            return
        }
        guard PushRelayClient.isConfigured else {
            evaluated.insert(site)
            print("[WebPush] auto-enable: relay not configured; skipping")
            return
        }
        Task { @MainActor in
            // x.com's home timeline only renders logged in; Facebook serves its
            // login form at the feed URL, so check the session cookie. Not
            // marked evaluated when logged out: the post-login feed rechecks.
            if site != .x {
                guard await Self.isLoggedIn(site) else { return }
            }
            guard !self.evaluated.contains(site) else { return }
            self.evaluated.insert(site)
            let center = UNUserNotificationCenter.current()
            let settings = await center.notificationSettings()
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                // Typically granted at onboarding → no dialog, just proceed.
                self.lastAuthorizationGranted = true
                self.start(site, coordinator: coordinator)
            case .notDetermined:
                // Never asked (onboarded before this feature): ask now as the
                // fallback, proceed on grant.
                guard !UserDefaults.standard.bool(forKey: PushRegistrar.notificationsPromptedKey) else { return }
                let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
                UserDefaults.standard.set(true, forKey: PushRegistrar.notificationsPromptedKey)
                print("[WebPush] auto-enable: permission (timeline fallback) granted=\(granted)")
                self.lastAuthorizationGranted = granted
                if granted { self.start(site, coordinator: coordinator) }
            default:
                // Granting later in iOS Settings re-arms this (retryIfNeeded).
                self.lastAuthorizationGranted = false
                print("[WebPush] auto-enable: notifications denied in Settings; skipping")
                debugNotify("Notifications denied in iOS Settings")
            }
        }
    }

    /// The settings toggle turned on: run the same flow for every logged-in
    /// site that isn't subscribed, asking for permission first if needed.
    /// `completion(false)` (nothing ended up subscribed) lets the toggle fall
    /// back to off.
    func enableFromSettings(coordinator: FilteredWebView.WebCoordinator, completion: @escaping (Bool) -> Void) {
        Task { @MainActor in
            var sites: [PushSite] = []
            for site in PushSite.allCases where !PushRegistrar.shared.isSubscribed(site) {
                if await Self.isLoggedIn(site) { sites.append(site) }
            }
            guard !sites.isEmpty else {
                completion(PushRegistrar.shared.isSubscribedToAny)
                return
            }
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
            self.batchSucceeded = false
            self.completion = completion
            sites.forEach { self.start($0, coordinator: coordinator) }
        }
    }

    /// The relay lost a subscription (see PushRegistrar.refreshRegistrations):
    /// re-arm that site's check. If its feed is already showing, go now;
    /// otherwise the next URL change on the feed picks it up.
    func relayLostSubscription(_ site: PushSite) {
        Self.setCheckPending(site, true)
        evaluated.remove(site)
        guard let coordinator = lastCoordinator, site.isHome(lastURL) else { return }
        maybeAutoEnable(site, coordinator: coordinator)
    }

    /// The settings toggle found notifications denied and is sending the user
    /// to iOS Settings. The system prompt can't be shown again, so this is the
    /// only way back; retryIfNeeded finishes the job when they return.
    func enableAfterSettingsGrant(coordinator: FilteredWebView.WebCoordinator) {
        lastCoordinator = coordinator
        awaitingSettingsGrant = true
        lastAuthorizationGranted = false
    }

    /// Foreground: an attempt interrupted by backgrounding gets another go,
    /// and so does one blocked on a permission the user has since granted in
    /// iOS Settings.
    func retryIfNeeded() {
        Task { @MainActor in
            let granted = await PushRegistrar.authorization() == .granted
            let newlyGranted = granted && self.lastAuthorizationGranted == false
            self.lastAuthorizationGranted = granted
            // Permission may have changed either way; let the toggle re-read.
            NotificationCenter.default.post(name: Self.stateChangedNotification, object: nil)

            let fromSettings = self.awaitingSettingsGrant
            let wasInterrupted = self.interrupted
            if granted { self.awaitingSettingsGrant = false }
            self.interrupted = []
            guard granted, !wasInterrupted.isEmpty || newlyGranted,
                  !PushRegistrar.userOptedOut,
                  PushRelayClient.isConfigured,
                  let coordinator = self.lastCoordinator else { return }
            for site in PushSite.allCases {
                let loggedIn = await Self.isLoggedIn(site)
                if wasInterrupted.contains(site) || (fromSettings && loggedIn) {
                    print("[WebPush] auto-enable: retrying \(site.rawValue) after foreground")
                    self.start(site, coordinator: coordinator)
                } else {
                    // Granted in iOS Settings on their own, or before logging
                    // in: same cue as a fresh session — go now if on the feed,
                    // else at the next feed visit.
                    print("[WebPush] auto-enable: permission granted in Settings; re-arming \(site.rawValue)")
                    self.relayLostSubscription(site)
                }
            }
        }
    }

    /// True while the hidden settings view is working on a subscription.
    var isEnabling: Bool { hiddenView != nil }

    /// Whether the shared web view store holds a session for `site`: its
    /// session cookie exists (only its presence is read). The hidden settings
    /// view is pointless without one, since the page redirects to login.
    static func isLoggedIn(_ site: PushSite) async -> Bool {
        let domain = site.sessionCookieDomain
        return await WKWebsiteDataStore.default().httpCookieStore.allCookies().contains {
            $0.name == site.sessionCookie && ($0.domain == domain || $0.domain.hasSuffix("." + domain))
        }
    }

    static func isLoggedInToAny() async -> Bool {
        for site in PushSite.allCases where await isLoggedIn(site) { return true }
        return false
    }

    // MARK: - The hidden settings view

    private func start(_ site: PushSite, coordinator: FilteredWebView.WebCoordinator) {
        lastCoordinator = coordinator
        if hiddenView != nil {
            // Another site (or this one) is in flight; queue behind it.
            if site != self.site, !queue.contains(site) { queue.append(site) }
            return
        }
        guard let window = Self.keyWindow() else {
            print("[WebPush] auto-enable: no window to attach the hidden view to")
            finishBatch()
            return
        }
        self.site = site

        // Same cookie store (logged in), the site's user agent (for x.com the
        // same client as the visible view),
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

        // Full-size so the site lays out normally, translated far off the right
        // edge so it's never visible; attached to the window so WebKit treats
        // it as a live page rather than throttling it as hidden.
        let view = WKWebView(frame: window.bounds, configuration: config)
        view.customUserAgent = site.settingsUserAgent
        if #available(iOS 16.4, *) { view.isInspectable = true }
        view.transform = CGAffineTransform(translationX: 100_000, y: 0)
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
        window.addSubview(view)
        hiddenView = view
        awaitingSubscription = false
        secondClickPending = false

        PushRegistrar.shared.onSubscriptionRegistered = { [weak self] scope in self?.onSubscribed(scope) }
        print("[WebPush] auto-enable: loading hidden \(site.rawValue) settings view")
        view.load(URLRequest(url: site.settingsURL))
        armTimeout(Self.toggleRenderTimeout, reason: "toggle never rendered")
    }

    // MARK: - Messages from PushAutoEnable.js

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.handlerName,
              let site,
              let body = message.body as? [String: Any],
              let event = body["event"] as? String else { return }
        switch event {
        case "ready":
            timeoutTask?.cancel()
            let checked = (body["checked"] as? Bool) ?? false
            print("[WebPush] auto-enable: toggle ready (checked=\(checked), \(body["elapsedMs"] ?? 0)ms)")
            if checked && PushRegistrar.shared.isSubscribed(site) {
                debugNotify("\(site.fallbackTitle) notifications already on ✓")
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

        case "logged-out":
            // The settings page bounced to the site's login. Not a failure
            // worth a debug banner; the check stays pending for the next login.
            finish(ok: false, reason: "logged out")

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
        guard awaitingSubscription, let site, PushSite.forScope(scope) == site else { return }
        awaitingSubscription = false
        timeoutTask?.cancel()
        PushRegistrar.setNotificationsOn(true)
        NotificationCenter.default.post(name: Self.stateChangedNotification, object: nil)
        print("[WebPush] auto-enable: \(site.rawValue) subscription registered; letting its backend POST finish")
        debugNotify("\(site.fallbackTitle) notifications enabled ✓")
        // The browser subscribe() has resolved, but the site now POSTs that
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
        guard hiddenView != nil, let site else { return }
        print("[WebPush] auto-enable finished (\(site.rawValue)): ok=\(ok) (\(reason))")
        if ok {
            Self.setCheckPending(site, false)
            batchSucceeded = true
        }
        teardown()
        NotificationCenter.default.post(name: Self.stateChangedNotification, object: nil)
        startNext()
    }

    /// The attempt in flight is over: run the next queued site, or report the
    /// batch to the settings toggle once nothing is left.
    private func startNext() {
        while let next = queue.first {
            queue.removeFirst()
            guard let coordinator = lastCoordinator else { break }
            start(next, coordinator: coordinator)
            if hiddenView != nil { return }
        }
        finishBatch()
    }

    private func finishBatch() {
        queue.removeAll()
        let done = completion
        completion = nil
        done?(batchSucceeded || PushRegistrar.shared.isSubscribedToAny)
        batchSucceeded = false
    }

    private func teardown() {
        timeoutTask?.cancel()
        timeoutTask = nil
        PushRegistrar.shared.onSubscriptionRegistered = nil
        awaitingSubscription = false
        secondClickPending = false
        site = nil
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
        guard hiddenView != nil, let site else { return }
        print("[WebPush] auto-enable: backgrounded mid-flight; will retry on foreground")
        interrupted = [site] + queue
        queue.removeAll()
        teardown()
        finishBatch()
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

// What the enable flow needs to know per site (app-only; PushSite itself lives
// in PushPayload.swift, which the service extension shares).
private extension PushSite {
    /// The page whose toggle turns push on for the logged-in account.
    var settingsURL: URL {
        switch self {
        case .x: return URL(string: "https://x.com/settings/push_notifications")!
        case .facebook: return URL(string: "https://www.facebook.com/settings/?tab=notifications")!
        }
    }

    /// x.com: the visible view's client. Facebook: desktop Chrome — its mobile
    /// site has no push setting, and its desktop page only hands its VAPID key
    /// to the browsers it knows; Chrome is the one verified to get it.
    var settingsUserAgent: String {
        switch self {
        case .x:
            return FilteredWebView.WebViewFactory.userAgent()
        case .facebook:
            return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
        }
    }

    var sessionCookie: String { self == .x ? "auth_token" : "c_user" }
    var sessionCookieDomain: String { self == .x ? "x.com" : "facebook.com" }

    /// X keeps its original key so existing installs don't re-check.
    var checkPendingKey: String { self == .x ? "pushCheckPending" : "pushCheckPending.\(rawValue)" }

    /// The authenticated feed: the cue for the silent attempt.
    func isHome(_ url: String) -> Bool {
        switch self {
        case .x:
            return url.contains("x.com/home") || url.contains("twitter.com/home")
        case .facebook:
            guard let u = URL(string: url), let host = u.host?.lowercased(),
                  host == "facebook.com" || host.hasSuffix(".facebook.com") else { return false }
            return u.path.isEmpty || u.path == "/" || u.path == "/home.php"
        }
    }

    /// Login / logout / account-switch flows.
    /// x.com: login, signup, SSO and add-account live under /i/flow/; /login
    /// and /logout are the plain entry points. Facebook: /login…, /logout.php,
    /// and /checkpoint (2FA and account checks during login).
    func isAuthFlow(_ url: String) -> Bool {
        guard let u = URL(string: url), let host = u.host?.lowercased() else { return false }
        let path = u.path
        switch self {
        case .x:
            guard host == "x.com" || host.hasSuffix(".x.com") || host == "twitter.com" || host.hasSuffix(".twitter.com") else { return false }
            return path.hasPrefix("/i/flow/") || path == "/login" || path == "/logout"
        case .facebook:
            guard host == "facebook.com" || host.hasSuffix(".facebook.com") else { return false }
            return path.hasPrefix("/login") || path == "/logout.php" || path.hasPrefix("/checkpoint")
        }
    }
}
