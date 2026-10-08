//
//  WebPushCrypto.swift
//  iOS (App) + NotificationService
//
//  Receiver-side Web Push crypto, a port of the Android app's WebPushCrypto.kt:
//  P-256 key generation for the subscription handed to the site, and
//  decryption of incoming messages in both encodings — RFC 8291 aes128gcm
//  (RFC 8188 framing) and the legacy draft-03 "aesgcm" that x.com's sender
//  still uses. Pure CryptoKit, no dependencies, so the Notification Service
//  Extension can run it with the shared Keychain keys.
//

import Foundation
import CryptoKit

enum WebPushCrypto {

    struct AuthError: Error, CustomStringConvertible {
        let description: String
        init(_ description: String) { self.description = description }
    }

    // MARK: - Keys

    static func generateKeyPair() -> P256.KeyAgreement.PrivateKey {
        P256.KeyAgreement.PrivateKey()
    }

    static func generateAuthSecret() -> Data {
        var bytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes)
    }

    /// X9.62 uncompressed point (0x04 || X || Y), what PushSubscription.getKey('p256dh') carries.
    static func uncompressedPoint(_ key: P256.KeyAgreement.PrivateKey) -> Data {
        key.publicKey.x963Representation
    }

    // MARK: - aes128gcm (RFC 8291 / RFC 8188)

    /// Decrypts a full RFC 8188 body: salt(16) | rs(4) | idlen(1) | keyid | records.
    static func decrypt(
        body: Data,
        receiverPrivateRaw: Data,
        receiverPublicUncompressed: Data,
        authSecret: Data
    ) throws -> Data {
        let b = [UInt8](body)
        guard b.count >= 21 else { throw AuthError("push body too short: \(b.count)") }
        let salt = Data(b[0..<16])
        let recordSize = (UInt32(b[16]) << 24) | (UInt32(b[17]) << 16) | (UInt32(b[18]) << 8) | UInt32(b[19])
        guard recordSize >= 18 else { throw AuthError("invalid record size \(recordSize)") }
        let keyIdLen = Int(b[20])
        guard b.count >= 21 + keyIdLen else { throw AuthError("truncated keyid") }
        let keyId = Data(b[21..<(21 + keyIdLen)])
        // For aes128gcm the keyid is the sender's ephemeral P-256 public key.
        guard keyIdLen == 65, keyId.first == 0x04 else {
            throw AuthError("keyid is not an uncompressed P-256 point (len=\(keyIdLen))")
        }

        let sharedSecret = try ecdh(privateRaw: receiverPrivateRaw, peerUncompressed: keyId)

        // RFC 8291 §3.3-3.4: two-stage HKDF.
        let prkKey = hmac(key: authSecret, data: sharedSecret)
        let keyInfo = Data("WebPush: info".utf8) + Data([0]) + receiverPublicUncompressed + keyId
        let ikm = hkdfExpand(prk: prkKey, info: keyInfo, length: 32)
        let prk = hmac(key: salt, data: ikm)
        let cek = hkdfExpand(prk: prk, info: Data("Content-Encoding: aes128gcm".utf8) + Data([0]), length: 16)
        let nonceBase = hkdfExpand(prk: prk, info: Data("Content-Encoding: nonce".utf8) + Data([0]), length: 12)

        // RFC 8188 §2: records of rs bytes (ciphertext incl. 16-byte tag).
        var out = Data()
        var offset = 21 + keyIdLen
        var seq: UInt64 = 0
        while offset < b.count {
            let end = min(offset + Int(recordSize), b.count)
            let record = Data(b[offset..<end])
            let isLast = end == b.count
            let plain: Data
            do {
                plain = try aesGcmOpen(record: record, key: cek, nonce: nonce(base: nonceBase, seq: seq))
            } catch {
                throw AuthError("GCM decryption failed at record \(seq)")
            }
            out.append(try stripPadding(plain, isLast: isLast))
            offset = end
            seq += 1
        }
        return out
    }

    // MARK: - aesgcm (draft-ietf-webpush-encryption-03)

    /// Decrypts a legacy aesgcm message. The body is bare ciphertext; the salt
    /// and the sender's ephemeral key arrive out of band in the Encryption /
    /// Crypto-Key headers (the relay forwards them in the APNs payload).
    static func decryptAesGcm(
        ciphertext: Data,
        salt: Data,
        senderPublicUncompressed: Data,
        receiverPrivateRaw: Data,
        receiverPublicUncompressed: Data,
        authSecret: Data
    ) throws -> Data {
        guard salt.count == 16 else { throw AuthError("bad salt length \(salt.count)") }
        guard senderPublicUncompressed.count == 65, senderPublicUncompressed.first == 0x04 else {
            throw AuthError("dh is not an uncompressed P-256 point")
        }
        let sharedSecret = try ecdh(privateRaw: receiverPrivateRaw, peerUncompressed: senderPublicUncompressed)

        // draft-03 §4.2: ikm = HKDF(auth_secret, ecdh, "Content-Encoding: auth\0", 32)
        let ikm = hkdfExpand(
            prk: hmac(key: authSecret, data: sharedSecret),
            info: Data("Content-Encoding: auth".utf8) + Data([0]),
            length: 32
        )
        // context = "P-256" || 0x00 || len(ua_pub) || ua_pub || len(as_pub) || as_pub
        let context = Data("P-256".utf8) + Data([0])
            + lengthPrefixed(receiverPublicUncompressed) + lengthPrefixed(senderPublicUncompressed)
        let prk = hmac(key: salt, data: ikm)
        let cek = hkdfExpand(prk: prk, info: Data("Content-Encoding: aesgcm".utf8) + Data([0]) + context, length: 16)
        let nonce = hkdfExpand(prk: prk, info: Data("Content-Encoding: nonce".utf8) + Data([0]) + context, length: 12)

        let padded: Data
        do {
            padded = try aesGcmOpen(record: ciphertext, key: cek, nonce: nonce)
        } catch {
            throw AuthError("GCM decryption failed (aesgcm)")
        }
        // draft-03 padding: uint16 pad length, then that many 0x00, then plaintext.
        let p = [UInt8](padded)
        guard p.count >= 2 else { throw AuthError("record too short for padding header") }
        let padLen = (Int(p[0]) << 8) | Int(p[1])
        guard 2 + padLen <= p.count else { throw AuthError("pad length \(padLen) exceeds record") }
        for i in 2..<(2 + padLen) where p[i] != 0 {
            throw AuthError("non-zero padding byte")
        }
        return Data(p[(2 + padLen)...])
    }

    /// "salt=abc; rs=4096" / "dh=xyz;p256ecdsa=..." → ["salt": "abc", ...]
    static func parseHeaderParams(_ header: String) -> [String: String] {
        var out: [String: String] = [:]
        for part in header.split(whereSeparator: { $0 == ";" || $0 == "," }) {
            guard let eq = part.firstIndex(of: "=") else { continue }
            let key = part[..<eq].trimmingCharacters(in: .whitespaces).lowercased()
            var value = part[part.index(after: eq)...].trimmingCharacters(in: .whitespaces)
            if value.hasPrefix("\""), value.hasSuffix("\""), value.count >= 2 {
                value = String(value.dropFirst().dropLast())
            }
            if !key.isEmpty { out[key] = value }
        }
        return out
    }

    // MARK: - Primitives

    private static func ecdh(privateRaw: Data, peerUncompressed: Data) throws -> Data {
        let priv: P256.KeyAgreement.PrivateKey
        let peer: P256.KeyAgreement.PublicKey
        do {
            priv = try P256.KeyAgreement.PrivateKey(rawRepresentation: privateRaw)
            peer = try P256.KeyAgreement.PublicKey(x963Representation: peerUncompressed)
        } catch {
            throw AuthError("invalid key material: \(error)")
        }
        let shared = try priv.sharedSecretFromKeyAgreement(with: peer)
        return shared.withUnsafeBytes { Data($0) }
    }

    private static func aesGcmOpen(record: Data, key: Data, nonce: Data) throws -> Data {
        guard record.count >= 16 else { throw AuthError("record shorter than the GCM tag") }
        let ct = record.prefix(record.count - 16)
        let tag = record.suffix(16)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ct, tag: tag)
        return try AES.GCM.open(box, using: SymmetricKey(data: key))
    }

    // RFC 8188 §2: plaintext || delimiter (0x02 last record, 0x01 otherwise) || 0x00*
    private static func stripPadding(_ plain: Data, isLast: Bool) throws -> Data {
        let p = [UInt8](plain)
        var i = p.count - 1
        while i >= 0 && p[i] == 0 { i -= 1 }
        guard i >= 0 else { throw AuthError("record is all padding zeros with no delimiter") }
        let expected: UInt8 = isLast ? 2 : 1
        guard p[i] == expected else { throw AuthError("bad padding delimiter \(p[i]) (expected \(expected))") }
        return Data(p[0..<i])
    }

    // RFC 8188 §2.3: nonce = NONCE_BASE XOR seq (96-bit big-endian counter).
    private static func nonce(base: Data, seq: UInt64) -> Data {
        var n = [UInt8](base)
        var s = seq
        var i = n.count - 1
        while s != 0 && i >= 4 {
            n[i] ^= UInt8(s & 0xFF)
            s >>= 8
            i -= 1
        }
        return Data(n)
    }

    private static func hmac(key: Data, data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }

    // Single-block HKDF-Expand (all our outputs are ≤ 32 bytes).
    private static func hkdfExpand(prk: Data, info: Data, length: Int) -> Data {
        precondition(length <= 32)
        return hmac(key: prk, data: info + Data([1])).prefix(length)
    }

    private static func lengthPrefixed(_ d: Data) -> Data {
        Data([UInt8(d.count >> 8), UInt8(d.count & 0xFF)]) + d
    }
}

// MARK: - base64url helpers shared by the push code

extension Data {
    init?(base64url: String) {
        var s = base64url.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s.append("=") }
        self.init(base64Encoded: s)
    }

    var base64urlString: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
