package com.imbue.bouncer.push

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPrivateKeySpec
import java.util.Base64

class WebPushCryptoTest {

    // RFC 8291 Appendix A test vector.
    private val uaPrivateScalar = b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")
    private val uaPublic = b64(
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
    )
    private val authSecret = b64("BTBZMqHH6r4Tts7J_aSIgg")
    private val body = b64(
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
            "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
            "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
    )

    @Test
    fun decryptsRfc8291TestVector() {
        val plaintext = WebPushCrypto.decrypt(
            body = body,
            receiverPrivatePkcs8 = pkcs8FromScalar(uaPrivateScalar),
            receiverPublicUncompressed = uaPublic,
            authSecret = authSecret,
        )
        assertEquals("When I grow up, I want to be a watermelon", String(plaintext))
    }

    @Test(expected = WebPushCrypto.AuthError::class)
    fun rejectsTamperedCiphertext() {
        val tampered = body.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
        WebPushCrypto.decrypt(tampered, pkcs8FromScalar(uaPrivateScalar), uaPublic, authSecret)
    }

    @Test(expected = WebPushCrypto.AuthError::class)
    fun rejectsWrongAuthSecret(): Unit {
        WebPushCrypto.decrypt(body, pkcs8FromScalar(uaPrivateScalar), uaPublic, ByteArray(16))
    }

    @Test
    fun generatedKeysRoundTripThroughEncoding() {
        val pair = WebPushCrypto.generateKeyPair()
        val point = WebPushCrypto.encodeUncompressedPoint(pair.public as ECPublicKey)
        assertEquals(65, point.size)
        assertEquals(0x04, point[0].toInt())
        // PKCS#8 round-trip preserves the key.
        val decoded = WebPushCrypto.decodePrivateKey(pair.private.encoded)
        assertArrayEquals(pair.private.encoded, decoded.encoded)
        assertEquals(16, WebPushCrypto.generateAuthSecret().size)
    }

    @Test
    fun aesGcmRoundTripsSenderEncryption() {
        // Sender side of draft-03 aesgcm, implemented independently here.
        val receiver = WebPushCrypto.generateKeyPair()
        val receiverPub = WebPushCrypto.encodeUncompressedPoint(
            receiver.public as java.security.interfaces.ECPublicKey,
        )
        val auth = WebPushCrypto.generateAuthSecret()
        val sender = WebPushCrypto.generateKeyPair()
        val senderPub = WebPushCrypto.encodeUncompressedPoint(
            sender.public as java.security.interfaces.ECPublicKey,
        )
        val salt = ByteArray(16).also { java.security.SecureRandom().nextBytes(it) }
        val plaintext = """{"title":"hi","body":"legacy encoding"}""".toByteArray()

        val shared = javax.crypto.KeyAgreement.getInstance("ECDH").run {
            init(sender.private)
            doPhase(receiver.public, true)
            generateSecret()
        }
        fun hmac(key: ByteArray, data: ByteArray) =
            javax.crypto.Mac.getInstance("HmacSHA256").run {
                init(javax.crypto.spec.SecretKeySpec(key, "HmacSHA256"))
                doFinal(data)
            }
        fun lp(b: ByteArray) = byteArrayOf((b.size ushr 8).toByte(), b.size.toByte()) + b
        val ikm = hmac(hmac(auth, shared), "Content-Encoding: auth".toByteArray() + byteArrayOf(0, 1))
            .copyOf(32)
        val context = "P-256".toByteArray() + byteArrayOf(0) + lp(receiverPub) + lp(senderPub)
        val prk = hmac(salt, ikm)
        val cek = hmac(prk, "Content-Encoding: aesgcm".toByteArray() + byteArrayOf(0) + context + byteArrayOf(1))
            .copyOf(16)
        val nonce = hmac(prk, "Content-Encoding: nonce".toByteArray() + byteArrayOf(0) + context + byteArrayOf(1))
            .copyOf(12)
        val padded = byteArrayOf(0, 2, 0, 0) + plaintext // 2 padding bytes
        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            javax.crypto.Cipher.ENCRYPT_MODE,
            javax.crypto.spec.SecretKeySpec(cek, "AES"),
            javax.crypto.spec.GCMParameterSpec(128, nonce),
        )
        val ciphertext = cipher.doFinal(padded)

        val decrypted = WebPushCrypto.decryptAesGcm(
            ciphertext = ciphertext,
            salt = salt,
            senderPublicUncompressed = senderPub,
            receiverPrivatePkcs8 = receiver.private.encoded,
            receiverPublicUncompressed = receiverPub,
            authSecret = auth,
        )
        assertArrayEquals(plaintext, decrypted)
    }

    @Test
    fun parsesEncryptionHeaderParams() {
        val params = WebPushCrypto.parseHeaderParams("keyid=p256dh;salt=DGv6ra1nlYgDCS1FRnbzlw")
        assertEquals("DGv6ra1nlYgDCS1FRnbzlw", params["salt"])
        val ck = WebPushCrypto.parseHeaderParams("dh=BNcRd...abc;p256ecdsa=BF5oEo0x")
        assertEquals("BNcRd...abc", ck["dh"])
        assertEquals("BF5oEo0x", ck["p256ecdsa"])
    }

    private fun pkcs8FromScalar(d: ByteArray): ByteArray {
        val params = AlgorithmParameters.getInstance("EC")
            .apply { init(ECGenParameterSpec("secp256r1")) }
            .getParameterSpec(ECParameterSpec::class.java)
        return KeyFactory.getInstance("EC")
            .generatePrivate(ECPrivateKeySpec(BigInteger(1, d), params))
            .encoded
    }

    private fun b64(s: String): ByteArray = Base64.getUrlDecoder().decode(s)
}
