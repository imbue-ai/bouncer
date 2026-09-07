package com.imbue.bouncer.push

import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.spec.PKCS8EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Receiver-side Web Push crypto: P-256 key generation for the subscription
 * handed to the site, and RFC 8291 (aes128gcm, RFC 8188 framing) decryption
 * of incoming push payloads. Pure JCA — no external dependencies.
 */
object WebPushCrypto {

    class AuthError(message: String, cause: Throwable? = null) : Exception(message, cause)

    fun generateKeyPair(): KeyPair =
        KeyPairGenerator.getInstance("EC")
            .apply { initialize(ECGenParameterSpec("secp256r1")) }
            .generateKeyPair()

    fun generateAuthSecret(): ByteArray = ByteArray(16).also { SecureRandom().nextBytes(it) }

    /** X9.62 uncompressed point: 0x04 || X(32) || Y(32). This is what PushSubscription.getKey('p256dh') carries. */
    fun encodeUncompressedPoint(publicKey: ECPublicKey): ByteArray {
        val out = ByteArray(65)
        out[0] = 0x04
        fixedLength(publicKey.w.affineX, 32).copyInto(out, 1)
        fixedLength(publicKey.w.affineY, 32).copyInto(out, 33)
        return out
    }

    fun decodePrivateKey(pkcs8: ByteArray) =
        KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(pkcs8))

    /**
     * Decrypts an RFC 8188 aes128gcm body using the subscription's keys.
     *
     * @param body full encrypted push body (salt | rs | idlen | keyid | records)
     * @param receiverPrivatePkcs8 PKCS#8 encoding of the subscription's P-256 private key
     * @param receiverPublicUncompressed the 65-byte public point given to the site
     * @param authSecret the 16-byte auth secret given to the site
     */
    fun decrypt(
        body: ByteArray,
        receiverPrivatePkcs8: ByteArray,
        receiverPublicUncompressed: ByteArray,
        authSecret: ByteArray,
    ): ByteArray {
        if (body.size < 21) throw AuthError("push body too short: ${body.size}")
        val buf = ByteBuffer.wrap(body)
        val salt = ByteArray(16).also { buf.get(it) }
        val recordSize = buf.int.toLong() and 0xFFFFFFFFL
        if (recordSize < 18) throw AuthError("invalid record size $recordSize")
        val keyIdLen = buf.get().toInt() and 0xFF
        val keyId = ByteArray(keyIdLen).also {
            if (buf.remaining() < keyIdLen) throw AuthError("truncated keyid")
            buf.get(it)
        }
        // For aes128gcm the keyid is the sender's ephemeral P-256 public key.
        if (keyIdLen != 65 || keyId[0] != 0x04.toByte()) {
            throw AuthError("keyid is not an uncompressed P-256 point (len=$keyIdLen)")
        }

        val privateKey = decodePrivateKey(receiverPrivatePkcs8)
        val senderPublic = decodePublicPoint(keyId)
        val sharedSecret = KeyAgreement.getInstance("ECDH").run {
            init(privateKey)
            doPhase(senderPublic, true)
            generateSecret()
        }

        // RFC 8291 §3.3-3.4: two-stage HKDF.
        val prkKey = hmacSha256(authSecret, sharedSecret)
        val keyInfo = "WebPush: info".toByteArray() + byteArrayOf(0) +
            receiverPublicUncompressed + keyId
        val ikm = hkdfExpand(prkKey, keyInfo, 32)
        val prk = hmacSha256(salt, ikm)
        val cek = hkdfExpand(prk, "Content-Encoding: aes128gcm".toByteArray() + byteArrayOf(0), 16)
        val nonceBase = hkdfExpand(prk, "Content-Encoding: nonce".toByteArray() + byteArrayOf(0), 12)

        // RFC 8188 §2: records of rs bytes (ciphertext incl. 16-byte tag).
        val out = ArrayList<ByteArray>()
        var offset = buf.position()
        var seq = 0L
        while (offset < body.size) {
            val end = minOf(offset + recordSize.toInt(), body.size)
            val record = body.copyOfRange(offset, end)
            val isLast = end == body.size
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(cek, "AES"),
                GCMParameterSpec(128, nonceFor(nonceBase, seq)),
            )
            val plain = try {
                cipher.doFinal(record)
            } catch (e: Exception) {
                throw AuthError("GCM decryption failed at record $seq", e)
            }
            out.add(stripPadding(plain, isLast))
            offset = end
            seq++
        }
        val total = out.sumOf { it.size }
        val result = ByteArray(total)
        var pos = 0
        out.forEach { it.copyInto(result, pos); pos += it.size }
        return result
    }

    /**
     * Decrypts a legacy "aesgcm" (draft-ietf-webpush-encryption-03) message.
     * Unlike aes128gcm, the body is bare ciphertext; the salt and the sender's
     * ephemeral public key arrive out-of-band in the Encryption / Crypto-Key
     * headers (which FCM forwards as message properties). x.com's sender still
     * uses this encoding.
     *
     * @param ciphertext the raw encrypted record (body of the push)
     * @param salt 16 bytes from the Encryption header's salt= parameter
     * @param senderPublicUncompressed 65 bytes from the Crypto-Key header's dh= parameter
     */
    fun decryptAesGcm(
        ciphertext: ByteArray,
        salt: ByteArray,
        senderPublicUncompressed: ByteArray,
        receiverPrivatePkcs8: ByteArray,
        receiverPublicUncompressed: ByteArray,
        authSecret: ByteArray,
    ): ByteArray {
        if (salt.size != 16) throw AuthError("bad salt length ${salt.size}")
        if (senderPublicUncompressed.size != 65 || senderPublicUncompressed[0] != 0x04.toByte()) {
            throw AuthError("dh is not an uncompressed P-256 point")
        }
        val privateKey = decodePrivateKey(receiverPrivatePkcs8)
        val senderPublic = decodePublicPoint(senderPublicUncompressed)
        val sharedSecret = KeyAgreement.getInstance("ECDH").run {
            init(privateKey)
            doPhase(senderPublic, true)
            generateSecret()
        }

        // draft-03 §4.2: ikm = HKDF(auth_secret, ecdh, "Content-Encoding: auth\x00", 32)
        val ikm = hkdfExpand(
            hmacSha256(authSecret, sharedSecret),
            "Content-Encoding: auth".toByteArray() + byteArrayOf(0),
            32,
        )
        // context = "P-256" || 0x00 || len(ua_pub) || ua_pub || len(as_pub) || as_pub
        val context = "P-256".toByteArray() + byteArrayOf(0) +
            lengthPrefixed(receiverPublicUncompressed) + lengthPrefixed(senderPublicUncompressed)
        val prk = hmacSha256(salt, ikm)
        val cek = hkdfExpand(prk, "Content-Encoding: aesgcm".toByteArray() + byteArrayOf(0) + context, 16)
        val nonce = hkdfExpand(prk, "Content-Encoding: nonce".toByteArray() + byteArrayOf(0) + context, 12)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, nonce))
        val padded = try {
            cipher.doFinal(ciphertext)
        } catch (e: Exception) {
            throw AuthError("GCM decryption failed (aesgcm)", e)
        }
        // draft-03 padding: uint16 pad length, then that many 0x00, then plaintext.
        if (padded.size < 2) throw AuthError("record too short for padding header")
        val padLen = ((padded[0].toInt() and 0xFF) shl 8) or (padded[1].toInt() and 0xFF)
        if (2 + padLen > padded.size) throw AuthError("pad length $padLen exceeds record")
        for (i in 2 until 2 + padLen) {
            if (padded[i] != 0.toByte()) throw AuthError("non-zero padding byte")
        }
        return padded.copyOfRange(2 + padLen, padded.size)
    }

    /** Parses "salt=abc; rs=4096" / "dh=xyz;p256ecdsa=..." header syntax into a param map. */
    fun parseHeaderParams(header: String): Map<String, String> =
        header.split(';', ',').mapNotNull { part ->
            val idx = part.indexOf('=')
            if (idx <= 0) return@mapNotNull null
            part.substring(0, idx).trim().lowercase() to
                part.substring(idx + 1).trim().removeSurrounding("\"")
        }.toMap()

    private fun lengthPrefixed(bytes: ByteArray): ByteArray =
        byteArrayOf((bytes.size ushr 8).toByte(), bytes.size.toByte()) + bytes

    private fun decodePublicPoint(uncompressed: ByteArray): ECPublicKey {
        val params = AlgorithmParameters.getInstance("EC")
            .apply { init(ECGenParameterSpec("secp256r1")) }
            .getParameterSpec(ECParameterSpec::class.java)
        val x = BigInteger(1, uncompressed.copyOfRange(1, 33))
        val y = BigInteger(1, uncompressed.copyOfRange(33, 65))
        return KeyFactory.getInstance("EC")
            .generatePublic(ECPublicKeySpec(ECPoint(x, y), params)) as ECPublicKey
    }

    // RFC 8188 §2: plaintext || delimiter (0x02 last record, 0x01 otherwise) || 0x00*
    private fun stripPadding(plain: ByteArray, isLast: Boolean): ByteArray {
        var i = plain.size - 1
        while (i >= 0 && plain[i] == 0.toByte()) i--
        if (i < 0) throw AuthError("record is all padding zeros with no delimiter")
        val delimiter = plain[i]
        val expected: Byte = if (isLast) 2 else 1
        if (delimiter != expected) throw AuthError("bad padding delimiter $delimiter (expected $expected)")
        return plain.copyOfRange(0, i)
    }

    // RFC 8188 §2.3: nonce = NONCE_BASE XOR seq (96-bit big-endian counter).
    private fun nonceFor(base: ByteArray, seq: Long): ByteArray {
        val nonce = base.copyOf()
        var s = seq
        var i = nonce.size - 1
        while (s != 0L && i >= 4) {
            nonce[i] = (nonce[i].toInt() xor (s and 0xFF).toInt()).toByte()
            s = s ushr 8
            i--
        }
        return nonce
    }

    private fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray =
        Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(key, "HmacSHA256"))
            doFinal(data)
        }

    // Single-block HKDF-Expand (all our outputs are ≤ 32 bytes).
    private fun hkdfExpand(prk: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length <= 32)
        return hmacSha256(prk, info + byteArrayOf(1)).copyOf(length)
    }

    private fun fixedLength(value: BigInteger, length: Int): ByteArray {
        val raw = value.toByteArray()
        val out = ByteArray(length)
        when {
            raw.size == length -> raw.copyInto(out)
            raw.size == length + 1 && raw[0] == 0.toByte() -> raw.copyInto(out, 0, 1)
            raw.size < length -> raw.copyInto(out, length - raw.size)
            else -> throw AuthError("coordinate too large: ${raw.size} bytes")
        }
        return out
    }
}
