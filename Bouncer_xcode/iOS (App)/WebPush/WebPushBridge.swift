//
//  WebPushBridge.swift
//  iOS (App)
//
//  The reply-style script message handler behind WebPushPolyfill.js. The
//  polyfill runs in the page world (where x.com's code lives), so this
//  handler is registered with `contentWorld: .page`, unlike the feedfilter
//  bridges. Requests are {op, scope, applicationServerKey?}; replies are
//  JSON-serializable values the polyfill wraps into PushSubscription objects.
//

import Foundation

enum WebPushBridge {
    static let handlerName = "bouncerPush"

    /// Returns (result, errorMessage) in WKScriptMessageHandlerWithReply form.
    static func handle(body: Any) async -> (Any?, String?) {
        guard let dict = body as? [String: Any], let op = dict["op"] as? String else {
            return (nil, "bouncerPush: malformed request")
        }
        let scope = (dict["scope"] as? String) ?? "https://x.com/"
        switch op {
        case "subscribe":
            let key = (dict["applicationServerKey"] as? String).flatMap { Data(base64url: $0) }
            guard let record = await PushRegistrar.shared.subscribe(scope: scope, appServerKey: key) else {
                return (nil, "NotAllowedError")
            }
            return (json(record), nil)

        case "getSubscription":
            if let record = PushRegistrar.shared.getSubscription(scope: scope) {
                return (json(record), nil)
            }
            return (NSNull(), nil)

        case "unsubscribe":
            return (await PushRegistrar.shared.unsubscribe(scope: scope), nil)

        case "permissionState":
            return (await PushRegistrar.shared.permissionState(), nil)

        default:
            return (nil, "bouncerPush: unknown op \(op)")
        }
    }

    /// The PushSubscription.toJSON() shape, which is what x.com posts to its backend.
    private static func json(_ r: PushSubscriptionRecord) -> [String: Any] {
        [
            "endpoint": r.endpoint,
            "expirationTime": NSNull(),
            "applicationServerKey": r.appServerKey?.base64urlString ?? NSNull(),
            "keys": [
                "p256dh": r.publicKey.base64urlString,
                "auth": r.authSecret.base64urlString,
            ],
        ]
    }
}
