package com.imbue.bouncer.push

import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.geckoview.WebPushSubscription
import java.math.BigInteger
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Full-transport verification against the real FCM web-push service. This
 * test plays BOTH sides:
 *
 *  - the browser side (the code under test): PushRegistrar mints a
 *    fcm.googleapis.com endpoint via the Play Services wp: registration;
 *  - the application-server side (x.com's role, implemented here): encrypt a
 *    payload per RFC 8291, sign a VAPID JWT (RFC 8292), and POST it to the
 *    endpoint per RFC 8030.
 *
 * Passing proves the whole pipeline: GSF handshake → endpoint → FCM accepts
 * the webpush POST → delivery broadcast → PushBroadcastReceiver → decryption
 * round-trips the exact plaintext. Requires a device/emulator with Play
 * services and network.
 */
@RunWith(AndroidJUnit4::class)
class PushTransportEndToEndTest {

    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    private val scope = "https://test.invalid/e2e-${System.currentTimeMillis()}"

    @After
    fun cleanup() {
        PushBroadcastReceiver.testDeliveryHook = null
        PushSubscriptionStore(ctx).remove(scope)
    }

    @Test
    fun subscribeReceiveDecryptRoundTrip() {
        // ---- x.com's role: a VAPID signing keypair ----
        val vapidKeys = generateP256()
        val vapidPublic = encodePoint(vapidKeys.public as ECPublicKey)

        // ---- Browser side: mint a subscription ----
        val subLatch = CountDownLatch(1)
        val subRef = AtomicReference<WebPushSubscription?>()
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            PushRegistrar.subscribe(ctx, scope, vapidPublic).accept { sub ->
                subRef.set(sub)
                subLatch.countDown()
            }
        }
        assertTrue("GSF registration timed out", subLatch.await(45, TimeUnit.SECONDS))
        val sub = subRef.get()
        assertNotNull("subscription was null (GSF registration failed)", sub)
        assertTrue(
            "unexpected endpoint: ${sub!!.endpoint}",
            sub.endpoint.startsWith("https://fcm.googleapis.com/fcm/send/"),
        )

        // ---- Delivery observation ----
        val pushLatch = CountDownLatch(1)
        val received = AtomicReference<Pair<String, ByteArray?>>()
        PushBroadcastReceiver.testDeliveryHook = { s, plaintext ->
            received.set(s to plaintext)
            pushLatch.countDown()
        }

        // ---- x.com's role: encrypt + VAPID-sign + POST ----
        val message = """{"title":"Bouncer e2e","body":"watermelon"}"""
        val body = encryptRfc8291(
            message.toByteArray(),
            sub.browserPublicKey,
            sub.authSecret,
        )
        val status = postWebPush(sub.endpoint, body, vapidKeys, vapidPublic)
        assertTrue("push POST rejected: HTTP $status", status in 200..299)

        // ---- Assert the device got it and decrypted it ----
        assertTrue("push never delivered to receiver", pushLatch.await(60, TimeUnit.SECONDS))
        assertEquals(scope, received.get().first)
        assertEquals(message, String(received.get().second!!))
    }

    // ----- sender-side RFC 8291 (aes128gcm) -----

    private fun encryptRfc8291(
        plaintext: ByteArray,
        uaPublic: ByteArray,
        authSecret: ByteArray,
    ): ByteArray {
        val eph = generateP256()
        val ephPub = encodePoint(eph.public as ECPublicKey)
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }

        val params = java.security.AlgorithmParameters.getInstance("EC")
            .apply { init(ECGenParameterSpec("secp256r1")) }
            .getParameterSpec(java.security.spec.ECParameterSpec::class.java)
        val x = BigInteger(1, uaPublic.copyOfRange(1, 33))
        val y = BigInteger(1, uaPublic.copyOfRange(33, 65))
        val uaPublicKey = java.security.KeyFactory.getInstance("EC")
            .generatePublic(java.security.spec.ECPublicKeySpec(java.security.spec.ECPoint(x, y), params))

        val shared = KeyAgreement.getInstance("ECDH").run {
            init(eph.private)
            doPhase(uaPublicKey, true)
            generateSecret()
        }
        val prkKey = hmac(authSecret, shared)
        val keyInfo = "WebPush: info".toByteArray() + byteArrayOf(0) + uaPublic + ephPub
        val ikm = hmac(prkKey, keyInfo + byteArrayOf(1)).copyOf(32)
        val prk = hmac(salt, ikm)
        val cek = hmac(prk, "Content-Encoding: aes128gcm".toByteArray() + byteArrayOf(0, 1)).copyOf(16)
        val nonce = hmac(prk, "Content-Encoding: nonce".toByteArray() + byteArrayOf(0, 1)).copyOf(12)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, nonce))
        val ciphertext = cipher.doFinal(plaintext + byteArrayOf(2)) // last-record delimiter

        return ByteBuffer.allocate(16 + 4 + 1 + 65 + ciphertext.size).apply {
            put(salt)
            putInt(4096)
            put(65.toByte())
            put(ephPub)
            put(ciphertext)
        }.array()
    }

    // ----- sender-side VAPID (RFC 8292) -----

    private fun postWebPush(
        endpoint: String,
        body: ByteArray,
        vapidKeys: KeyPair,
        vapidPublic: ByteArray,
    ): Int {
        val jwt = vapidJwt(endpoint, vapidKeys)
        val conn = URL(endpoint).openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("TTL", "60")
            conn.setRequestProperty("Content-Encoding", "aes128gcm")
            conn.setRequestProperty("Urgency", "high")
            conn.setRequestProperty(
                "Authorization",
                "vapid t=$jwt, k=${b64url(vapidPublic)}",
            )
            conn.outputStream.use { it.write(body) }
            conn.responseCode
        } finally {
            conn.disconnect()
        }
    }

    private fun vapidJwt(endpoint: String, keys: KeyPair): String {
        val origin = URL(endpoint).let { "${it.protocol}://${it.host}" }
        val header = b64url("""{"typ":"JWT","alg":"ES256"}""".toByteArray())
        val exp = System.currentTimeMillis() / 1000 + 12 * 3600
        val claims = b64url(
            """{"aud":"$origin","exp":$exp,"sub":"mailto:e2e@imbue.com"}""".toByteArray(),
        )
        val der = Signature.getInstance("SHA256withECDSA").run {
            initSign(keys.private)
            update("$header.$claims".toByteArray())
            sign()
        }
        return "$header.$claims.${b64url(derToJose(der))}"
    }

    // JOSE ES256 signatures are raw r||s (32+32 bytes), not DER.
    private fun derToJose(der: ByteArray): ByteArray {
        fun trim(b: ByteArray): ByteArray {
            var i = 0
            while (i < b.size - 1 && b[i] == 0.toByte()) i++
            return b.copyOfRange(i, b.size)
        }
        var offset = 3 // SEQUENCE, len, INTEGER
        val rLen = der[offset].toInt()
        val r = trim(der.copyOfRange(offset + 1, offset + 1 + rLen))
        offset += 1 + rLen + 1 // r bytes + INTEGER tag
        val sLen = der[offset].toInt()
        val s = trim(der.copyOfRange(offset + 1, offset + 1 + sLen))
        val out = ByteArray(64)
        r.copyInto(out, 32 - r.size)
        s.copyInto(out, 64 - s.size)
        return out
    }

    // ----- helpers -----

    private fun generateP256(): KeyPair =
        KeyPairGenerator.getInstance("EC")
            .apply { initialize(ECGenParameterSpec("secp256r1")) }
            .generateKeyPair()

    private fun encodePoint(key: ECPublicKey): ByteArray {
        fun fixed(v: BigInteger): ByteArray {
            val raw = v.toByteArray()
            val out = ByteArray(32)
            if (raw.size == 33) raw.copyInto(out, 0, 1) else raw.copyInto(out, 32 - raw.size)
            return out
        }
        return byteArrayOf(4) + fixed(key.w.affineX) + fixed(key.w.affineY)
    }

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray =
        Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(key, "HmacSHA256"))
            doFinal(data)
        }

    private fun b64url(bytes: ByteArray): String =
        Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
}
