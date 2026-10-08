//
//  PushSubscriptionStore.swift
//  iOS (App) + NotificationService
//
//  Persists Web Push subscriptions keyed by service-worker scope, in a
//  Keychain access group shared with the Notification Service Extension
//  (which needs the private key to decrypt pushes while the app isn't
//  running). Each record holds the P-256 keypair + auth secret this app
//  generated for the site — we are the "browser", so we hold the private
//  half — plus the relay endpoint the site's server delivers to. The port of
//  Android's PushSubscriptionStore.kt.
//

import Foundation
import Security

struct PushSubscriptionRecord: Codable {
    /// Opaque id embedded in the endpoint URL; the relay and the APNs payload
    /// carry it so an incoming push maps back to these keys.
    let id: String
    let scope: String
    let endpoint: String
    /// The site's VAPID public key (uncompressed point), bound at the relay.
    let appServerKey: Data?
    /// 65-byte uncompressed P-256 point handed to the site as p256dh.
    let publicKey: Data
    /// 32-byte raw private scalar (CryptoKit rawRepresentation).
    let privateKey: Data
    /// 16-byte auth secret handed to the site.
    let authSecret: Data
    let createdAt: Date
}

enum PushSubscriptionStore {
    // Team-prefixed so the app and the extension (both signed by this team,
    // both listing it under keychain-access-groups) share the items.
    static let accessGroup = "LDDYAR29MP.com.imbue.xbouncer.push"
    private static let service = "com.imbue.xbouncer.webpush"

    static func save(_ record: PushSubscriptionRecord) throws {
        let data = try JSONEncoder().encode(record)
        var attrs = baseQuery(account: record.scope)
        attrs[kSecValueData as String] = data
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemDelete(baseQuery(account: record.scope) as CFDictionary)
        let status = SecItemAdd(attrs as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status),
                          userInfo: [NSLocalizedDescriptionKey: "Keychain add failed (\(status))"])
        }
    }

    static func get(scope: String) -> PushSubscriptionRecord? {
        var query = baseQuery(account: scope)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(PushSubscriptionRecord.self, from: data)
    }

    /// Lookup by the id carried in the push (one or two records; a scan is fine).
    static func get(id: String) -> PushSubscriptionRecord? {
        all().first { $0.id == id }
    }

    static func remove(scope: String) {
        SecItemDelete(baseQuery(account: scope) as CFDictionary)
    }

    static func all() -> [PushSubscriptionRecord] {
        var query = baseQuery(account: nil)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitAll
        var items: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &items) == errSecSuccess,
              let datas = items as? [Data] else { return [] }
        return datas.compactMap { try? JSONDecoder().decode(PushSubscriptionRecord.self, from: $0) }
    }

    private static func baseQuery(account: String?) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccessGroup as String: accessGroup,
        ]
        if let account { q[kSecAttrAccount as String] = account }
        return q
    }
}
