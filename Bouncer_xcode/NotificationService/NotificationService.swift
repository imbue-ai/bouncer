//
//  NotificationService.swift
//  NotificationService
//
//  Notification Service Extension: turns a relayed Web Push message into the
//  notification x.com meant to show, without the app running.
//
//  The relay (twitter-filter-backend lambda/push_relay.py) forwards x.com's
//  still-encrypted message as an APNs alert push with mutable-content=1, a
//  generic fallback alert in `aps`, and the ciphertext plus its headers under
//  `wp`. iOS runs this extension before display; we look the subscription's
//  keys up in the shared Keychain, decrypt, parse the payload the way x.com's
//  own service worker does (PushPayload), fetch the avatar as an attachment,
//  and hand back the rewritten content. Anything that fails leaves the
//  fallback alert in place, so the user always sees something.
//
//  iOS can't suppress a push from here, so x.com's `silent` messages are shown
//  as quietly as the API allows (passive, no sound) rather than hidden.
//

import UserNotifications

final class NotificationService: UNNotificationServiceExtension {

    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        bestAttempt = content

        if let data = try? JSONSerialization.data(withJSONObject: request.content.userInfo, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) {
            NSLog("[WebPush NSE] payload: %@", text)
        }
        let wpInfo = request.content.userInfo["wp"] as? [String: Any]
        NSLog("[WebPush NSE] push received: enc=%@ sub=%@ bodyBytes=%d",
              (wpInfo?["enc"] as? String) ?? "-",
              String(((wpInfo?["sub"] as? String) ?? "-").prefix(10)),
              Data(base64Encoded: (wpInfo?["body"] as? String) ?? "")?.count ?? 0)
        guard let wp = wpInfo,
              let subId = wp["sub"] as? String,
              let record = PushSubscriptionStore.get(id: subId) else {
            NSLog("[WebPush NSE] no wp payload or unknown subscription; showing fallback")
            finish(content)
            return
        }

        let plaintext: Data?
        do {
            plaintext = try decrypt(wp, record: record)
        } catch {
            NSLog("[WebPush NSE] decryption failed: \(error)")
            finish(content)
            return
        }

        let payload = PushPayload.parse(plaintext) ?? PushPayload.fallback
        NSLog("[WebPush NSE] decrypted %d bytes; parsed=%@ title=\"%@\"",
              plaintext?.count ?? 0, PushPayload.parse(plaintext) == nil ? "no (fallback)" : "yes", payload.title)
        let tag = payload.tag ?? record.scope

        // Same-tag bundling as x.com's worker: count what's already showing
        // under this tag and re-render with the multi_* templates.
        UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
            let open = delivered.first { $0.request.content.threadIdentifier == tag }
            let prior = (open?.request.content.userInfo[Self.countKey] as? Int) ?? (open == nil ? 0 : 1)
            let count = prior + 1
            let rendered = payload.render(count: count)

            content.title = rendered.title
            content.body = rendered.body ?? ""
            content.threadIdentifier = tag
            var userInfo = content.userInfo
            userInfo[Self.urlKey] = PushPayload.resolveClickURL(rendered.uri).absoluteString
            userInfo[Self.countKey] = count
            content.userInfo = userInfo
            if payload.silent {
                content.sound = nil
                content.interruptionLevel = .passive
            }
            // Replace the previous notification in this thread, like the
            // worker's tag-based replacement, by reusing its identifier.
            if let open {
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [open.request.identifier])
            }

            self.attachIcon(payload.iconURL, to: content) {
                NSLog("[WebPush NSE] delivering: title=\"%@\" count=%d url=%@ icon=%@",
                      content.title, count, userInfo[Self.urlKey] as? String ?? "-", content.attachments.isEmpty ? "no" : "yes")
                self.finish(content)
            }
        }
    }

    override func serviceExtensionTimeWillExpire() {
        // Out of time: deliver whatever we have (decrypted text without the
        // avatar, or the relay's fallback alert).
        if let content = bestAttempt { finish(content) }
    }

    // MARK: - Pieces

    private func decrypt(_ wp: [String: Any], record: PushSubscriptionRecord) throws -> Data? {
        let enc = (wp["enc"] as? String) ?? "aesgcm"
        if enc == "none" { return nil } // data-less push → generic notification
        guard let bodyB64 = wp["body"] as? String, let body = Data(base64Encoded: bodyB64) else {
            throw WebPushCrypto.AuthError("missing body")
        }
        switch enc {
        case "aesgcm":
            guard let salt = (wp["salt"] as? String).flatMap({ Data(base64url: $0) }),
                  let dh = (wp["dh"] as? String).flatMap({ Data(base64url: $0) }) else {
                throw WebPushCrypto.AuthError("aesgcm push missing salt/dh")
            }
            return try WebPushCrypto.decryptAesGcm(
                ciphertext: body,
                salt: salt,
                senderPublicUncompressed: dh,
                receiverPrivateRaw: record.privateKey,
                receiverPublicUncompressed: record.publicKey,
                authSecret: record.authSecret
            )
        case "aes128gcm":
            return try WebPushCrypto.decrypt(
                body: body,
                receiverPrivateRaw: record.privateKey,
                receiverPublicUncompressed: record.publicKey,
                authSecret: record.authSecret
            )
        default:
            throw WebPushCrypto.AuthError("unsupported encoding \(enc)")
        }
    }

    // The web icon (the sender's avatar) becomes a notification attachment.
    // Bounded by the extension's time budget; failure just means no avatar.
    private func attachIcon(_ iconURL: String?, to content: UNMutableNotificationContent, completion: @escaping () -> Void) {
        guard let iconURL, let url = URL(string: iconURL), url.scheme == "https" else {
            completion()
            return
        }
        let task = URLSession.shared.downloadTask(with: url) { tmp, response, _ in
            defer { completion() }
            guard let tmp,
                  let http = response as? HTTPURLResponse, http.statusCode == 200 else { return }
            let ext = Self.imageExtension(for: http.mimeType, url: url)
            let dest = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString)
                .appendingPathExtension(ext)
            do {
                try FileManager.default.moveItem(at: tmp, to: dest)
                let attachment = try UNNotificationAttachment(identifier: "icon", url: dest)
                content.attachments = [attachment]
            } catch {
                NSLog("[WebPush NSE] attachment failed: \(error)")
            }
        }
        task.resume()
    }

    private static func imageExtension(for mimeType: String?, url: URL) -> String {
        switch mimeType?.lowercased() {
        case "image/png": return "png"
        case "image/gif": return "gif"
        case "image/webp": return "webp"
        case "image/jpeg", "image/jpg": return "jpg"
        default:
            let ext = url.pathExtension.lowercased()
            return ["png", "gif", "webp", "jpg", "jpeg"].contains(ext) ? ext : "jpg"
        }
    }

    private func finish(_ content: UNNotificationContent) {
        guard let handler = contentHandler else { return }
        contentHandler = nil
        handler(content)
    }

    static let urlKey = "bouncerURL"          // read by PushRegistrar.handleNotificationTap
    static let countKey = "bouncerPushCount"  // same-tag bundle size
}
