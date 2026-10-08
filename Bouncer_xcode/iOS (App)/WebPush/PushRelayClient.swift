//
//  PushRelayClient.swift
//  iOS (App)
//
//  Talks to the backend's Web Push relay (twitter-filter-backend
//  lambda/push_relay.py). The relay is the "push service" x.com posts to; it
//  forwards each message through APNs to this device. The app only has to
//  tell it which APNs token a subscription id maps to.
//
//  Base URL comes from the BouncerPushRelayURL Info.plist key, which the
//  BOUNCER_PUSH_RELAY_URL build setting fills per configuration (the
//  `push_relay_endpoint` Terraform output of the matching environment).
//  When it's empty the relay is treated as absent and subscribe() fails
//  cleanly, so x.com just sees push as unavailable.
//

import Foundation

enum PushRelayClient {

    struct RelayError: Error, CustomStringConvertible {
        let description: String
    }

    static var baseURL: URL? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "BouncerPushRelayURL") as? String,
              !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        return url
    }

    static var isConfigured: Bool { baseURL != nil }

    /// Registers (or refreshes) a subscription's device token. Returns the
    /// endpoint URL to hand to the site.
    static func register(
        subscriptionId: String,
        deviceTokenHex: String,
        environment: String,
        appServerKey: Data?
    ) async throws -> String {
        var body: [String: Any] = ["deviceToken": deviceTokenHex, "environment": environment]
        if let appServerKey { body["appServerKey"] = appServerKey.base64urlString }
        let (data, status) = try await send("PUT", path: "/push/subscriptions/\(subscriptionId)", json: body)
        guard status == 200,
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let endpoint = obj["endpoint"] as? String else {
            throw RelayError(description: "register failed: HTTP \(status) \(String(data: data, encoding: .utf8) ?? "")")
        }
        return endpoint
    }

    static func unregister(subscriptionId: String) async throws {
        let (_, status) = try await send("DELETE", path: "/push/subscriptions/\(subscriptionId)", json: nil)
        guard status == 204 || status == 404 else {
            throw RelayError(description: "unregister failed: HTTP \(status)")
        }
    }

    private static func send(_ method: String, path: String, json: [String: Any]?) async throws -> (Data, Int) {
        guard let base = baseURL else { throw RelayError(description: "push relay not configured") }
        guard let url = URL(string: path, relativeTo: base)?.absoluteURL else {
            throw RelayError(description: "bad relay URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 20
        if let json {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: json)
        }
        // Same App Check token the WebSocket bridge sends as token_ios; the
        // relay verifies it against Firebase before touching any record.
        if let token = await AppCheckBridge.shared.getToken() {
            req.setValue(token, forHTTPHeaderField: "X-Firebase-AppCheck")
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return (data, status)
    }
}
