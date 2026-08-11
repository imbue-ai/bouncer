package com.imbue.bouncer.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Base64
import android.util.Log
import com.imbue.bouncer.web.BouncerGeckoView

/**
 * Receives Google Play Services push broadcasts (the same c2dm plumbing
 * Chrome uses for Web Push):
 *
 *  - REGISTRATION: answer to a [PushRegistrar] token request (or a
 *    GMS-initiated token rotation).
 *  - RECEIVE with subtype "wp:<id>": an actual Web Push message — the raw
 *    RFC 8291-encrypted body the site's server POSTed to our
 *    fcm.googleapis.com endpoint. Decrypt and hand to Gecko, which fires the
 *    `push` event in the site's service worker.
 *
 * Exported but sender-gated by com.google.android.c2dm.permission.SEND, which
 * only Play Services holds. Runs on the main thread in the main process,
 * where BouncerApplication.onCreate has already warmed the GeckoRuntime;
 * onPushEvent queues internally until Gecko is up, so a cold-start push
 * wakeup works with no GeckoSession open.
 */
class PushBroadcastReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_REGISTRATION -> {
                val registrationId = intent.getStringExtra("registration_id")
                if (registrationId != null) {
                    PushRegistrar.onRegistration(context, registrationId)
                } else {
                    Log.w(TAG, "REGISTRATION without registration_id (error=${intent.getStringExtra("error")})")
                }
            }
            ACTION_RECEIVE -> onMessage(context, intent)
        }
    }

    private fun onMessage(context: Context, intent: Intent) {
        val subtype = intent.getStringExtra("subtype") ?: return
        // Non-"wp:" traffic belongs to other FCM users in this app (e.g. the
        // Firebase SDK); leave it alone.
        val subId = subtype.removePrefix("wp:").takeIf { it != subtype } ?: return
        val store = PushSubscriptionStore(context)
        val scope = store.scopeForId(subId) ?: run {
            Log.w(TAG, "push for unknown subscription id")
            return
        }
        val record = store.get(scope) ?: return

        if (com.imbue.bouncer.BuildConfig.DEBUG) {
            val keys = intent.extras?.keySet()?.joinToString()
            Log.i(TAG, "push extras: [$keys]")
        }

        val body = intent.getByteArrayExtra("rawData")
        // FCM forwards the webpush Encryption/Crypto-Key headers as message
        // properties; their presence means the legacy aesgcm encoding
        // (draft-03), which x.com's sender still uses. Their absence (or an
        // explicit content-encoding) means RFC 8188 aes128gcm with a
        // self-describing body.
        val encryptionHeader = intent.getStringExtra("encryption")
        val cryptoKeyHeader = intent.getStringExtra("crypto-key")
            ?: intent.getStringExtra("crypto_key")
        val plaintext = if (body == null || body.isEmpty()) {
            null // data-less push: fire a payload-less push event
        } else {
            try {
                if (encryptionHeader != null && cryptoKeyHeader != null &&
                    intent.getStringExtra("content-encoding") != "aes128gcm"
                ) {
                    val salt = WebPushCrypto.parseHeaderParams(encryptionHeader)["salt"]
                        ?: throw WebPushCrypto.AuthError("Encryption header missing salt")
                    val dh = WebPushCrypto.parseHeaderParams(cryptoKeyHeader)["dh"]
                        ?: throw WebPushCrypto.AuthError("Crypto-Key header missing dh")
                    WebPushCrypto.decryptAesGcm(
                        ciphertext = body,
                        salt = Base64.decode(salt, Base64.URL_SAFE),
                        senderPublicUncompressed = Base64.decode(dh, Base64.URL_SAFE),
                        receiverPrivatePkcs8 = record.privateKeyPkcs8,
                        receiverPublicUncompressed = record.publicKeyUncompressed,
                        authSecret = record.authSecret,
                    )
                } else {
                    WebPushCrypto.decrypt(
                        body = body,
                        receiverPrivatePkcs8 = record.privateKeyPkcs8,
                        receiverPublicUncompressed = record.publicKeyUncompressed,
                        authSecret = record.authSecret,
                    )
                }
            } catch (e: Exception) {
                Log.e(TAG, "push decryption failed for $scope", e)
                return
            }
        }
        Log.i(TAG, "delivering push for $scope (${plaintext?.size ?: 0} bytes)")
        testDeliveryHook?.invoke(scope, plaintext)
        val runtime = BouncerGeckoView.runtimeOrNull() ?: run {
            Log.e(TAG, "no GeckoRuntime for push delivery")
            return
        }
        // The scope string must go back to Gecko exactly as it was handed to
        // onSubscribe — it reconstructs the principal from it.
        if (plaintext != null) {
            runtime.webPushController.onPushEvent(scope, plaintext)
        } else {
            runtime.webPushController.onPushEvent(scope)
        }
    }

    companion object {
        private const val TAG = "FF/PushReceiver"
        private const val ACTION_REGISTRATION = "com.google.android.c2dm.intent.REGISTRATION"
        private const val ACTION_RECEIVE = "com.google.android.c2dm.intent.RECEIVE"

        /** Observation point for the end-to-end instrumentation test; unused in production. */
        @androidx.annotation.VisibleForTesting
        @Volatile
        var testDeliveryHook: ((scope: String, plaintext: ByteArray?) -> Unit)? = null
    }
}
