package com.imbue.bouncer.push

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.WebPushSubscription
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

/**
 * Mints real Web Push endpoints from Google Play Services, the same way
 * Chrome does: a TOKEN_REQUEST broadcast with subtype "wp:<id>" and the
 * site's VAPID key as the sender registers a web-push token with FCM, and
 * `https://fcm.googleapis.com/fcm/send/<token>` then accepts standard
 * RFC 8030 POSTs from the site's application server — no app server of our
 * own involved. (Protocol reference: UnifiedPush embedded-fcm-distributor 3.x.)
 *
 * Registration is an async broadcast handshake: the token arrives later via
 * a c2dm REGISTRATION broadcast ([PushBroadcastReceiver]), correlated back to
 * the pending subscribe through the "kid" we chose.
 */
object PushRegistrar {

    private const val TAG = "FF/PushRegistrar"

    private const val GSF_PACKAGE = "com.google.android.gms"
    private const val ACTION_TOKEN_REQUEST = "com.google.iid.TOKEN_REQUEST"
    private const val ENDPOINT_TEMPLATE = "https://fcm.googleapis.com/fcm/send/%s"
    private const val REGISTRATION_TIMEOUT_MS = 30_000L

    private class Pending(
        val scope: String,
        val appServerKey: ByteArray,
        val result: GeckoResult<WebPushSubscription>,
        val timeout: Runnable,
    )

    private val pending = ConcurrentHashMap<String, Pending>()
    private val mainHandler = Handler(Looper.getMainLooper())

    /**
     * Fires (on the main thread) with the scope each time a subscription is
     * successfully registered. The enable-notifications flow uses this as the
     * authoritative "notifications are on" signal — proof the user granted
     * permission and the site's subscribe() reached us and got an endpoint —
     * rather than guessing from the settings-page checkbox.
     */
    @Volatile
    var onSubscriptionRegistered: ((scope: String) -> Unit)? = null

    /**
     * Starts a web-push registration for [scope]. The returned result
     * completes when Play Services answers (or null on failure/timeout).
     */
    fun subscribe(
        ctx: Context,
        scope: String,
        appServerKey: ByteArray?,
    ): GeckoResult<WebPushSubscription> {
        val result = GeckoResult<WebPushSubscription>()
        if (appServerKey == null) {
            // FCM's web-push ingestion authenticates senders against the VAPID
            // key bound at registration; a keyless subscription can't work.
            Log.w(TAG, "subscribe without appServerKey unsupported: $scope")
            result.complete(null)
            return result
        }
        if (!isPlayServicesAvailable(ctx)) {
            Log.w(TAG, "Play Services unavailable; cannot subscribe")
            result.complete(null)
            return result
        }
        val subId = newSubscriptionId()
        val timeout = Runnable {
            if (pending.remove(subId) != null) {
                Log.e(TAG, "registration timed out for $scope")
                result.complete(null)
            }
        }
        pending[subId] = Pending(scope, appServerKey, result, timeout)
        mainHandler.postDelayed(timeout, REGISTRATION_TIMEOUT_MS)

        val vapid = Base64.encodeToString(
            appServerKey,
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
        )
        val intent = Intent(ACTION_TOKEN_REQUEST).apply {
            `package` = GSF_PACKAGE
            putExtra("scope", "GCM")
            putExtra("sender", vapid)
            putExtra("subscription", vapid)
            putExtra("X-subscription", vapid)
            putExtra("subtype", "wp:$subId")
            putExtra("X-subtype", "wp:$subId")
            // Echoed back verbatim in registration_id as "<kid>:<token>".
            putExtra("kid", "0:$subId")
            // Empty PendingIntent identifies this app (creator UID) to GMS.
            putExtra(
                "app",
                PendingIntent.getBroadcast(ctx, 0, Intent(), PendingIntent.FLAG_IMMUTABLE),
            )
        }
        ctx.sendBroadcast(intent)
        Log.i(TAG, "requested web-push token for $scope")
        return result
    }

    /** Handles the REGISTRATION answer; registrationId is "<0|1>:<subId>:<token>". */
    fun onRegistration(ctx: Context, registrationId: String) {
        val parts = registrationId.split(":", limit = 3)
        if (parts.size != 3) {
            Log.w(TAG, "unparseable registration_id")
            return
        }
        val subId = parts[1]
        val token = parts[2]
        val endpoint = ENDPOINT_TEMPLATE.format(token)
        val request = pending.remove(subId)
        if (request != null) {
            mainHandler.removeCallbacks(request.timeout)
            val record = PushSubscriptionStore(ctx)
                .create(request.scope, subId, endpoint, request.appServerKey)
            Log.i(TAG, "registered ${request.scope} → fcm.googleapis.com endpoint")
            request.result.complete(
                WebPushSubscription(
                    request.scope,
                    endpoint,
                    // Never echo appServerKey back to Gecko — its
                    // getSubscription path corrupts it on the page.
                    null,
                    record.publicKeyUncompressed,
                    record.authSecret,
                ),
            )
            mainHandler.post { onSubscriptionRegistered?.invoke(request.scope) }
            return
        }
        // No pending request: GMS rotated the token for an existing
        // registration. The old endpoint is dead, so drop the record and fire
        // pushsubscriptionchange so the site resubscribes.
        val store = PushSubscriptionStore(ctx)
        val scope = store.scopeForId(subId) ?: return
        val stale = store.get(scope)
        if (stale != null && stale.endpoint == endpoint) return // no change
        Log.i(TAG, "token rotated for $scope; invalidating subscription")
        store.remove(scope)
        mainHandler.post {
            com.imbue.bouncer.web.BouncerGeckoView.runtimeOrNull()
                ?.webPushController
                ?.onSubscriptionChanged(scope)
        }
    }

    private fun isPlayServicesAvailable(ctx: Context): Boolean = runCatching {
        ctx.packageManager.getPackageInfo(GSF_PACKAGE, PackageManager.GET_ACTIVITIES)
        true
    }.getOrDefault(false)

    private fun newSubscriptionId(): String {
        val bytes = ByteArray(16).also { SecureRandom().nextBytes(it) }
        // Hex keeps the id free of ':' and URL-safe; it rides inside
        // registration_id's colon-delimited format.
        return bytes.joinToString("") { "%02x".format(it) }
    }
}
