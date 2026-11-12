package com.imbue.bouncer.push

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.util.Base64
import android.util.Log
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.WebPushSubscription
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

/**
 * Mints real Web Push endpoints from Google Play Services, the same way
 * Chrome does: a token request with subtype "wp:<id>" and the site's VAPID
 * key as the sender registers a web-push token with FCM, and
 * `https://fcm.googleapis.com/fcm/send/<token>` then accepts standard
 * RFC 8030 POSTs from the site's application server — no app server of our
 * own involved. (Protocol reference: UnifiedPush embedded-fcm-distributor 3.1.)
 *
 * The request goes over Messenger IPC to Play Services' bound
 * c2dm.intent.REGISTER service, which answers on our replyTo Messenger.
 * The older one-way com.google.iid.TOKEN_REQUEST broadcast (answered by a
 * c2dm REGISTRATION broadcast) stopped getting any reply around Play
 * Services 26.4x (Nov 2026): every subscribe silently timed out and x.com
 * showed "unsupported browser". REGISTRATION broadcasts still arrive for
 * GMS-initiated token rotation ([PushBroadcastReceiver] → [onRegistration]).
 */
object PushRegistrar {

    private const val TAG = "FF/PushRegistrar"

    private const val GSF_PACKAGE = "com.google.android.gms"
    private const val ACTION_C2M_REGISTER = "com.google.android.c2dm.intent.REGISTER"
    private const val OPCODE_SEND = 1
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
        val extras = Bundle().apply {
            putString("scope", "GCM")
            putString("sender", vapid)
            putString("subscription", vapid)
            putString("X-subscription", vapid)
            putString("subtype", "wp:$subId")
            putString("X-subtype", "wp:$subId")
            // Echoed back verbatim in registration_id as "<kid>:<token>".
            putString("kid", "0:$subId")
        }
        sendTokenRequest(ctx.applicationContext, scope, extras)
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

    // One bind per request: subscribes are rare (once per site), so a
    // long-lived connection isn't worth its lifecycle handling. Replies land
    // on the main thread; a missing or failed reply is covered by the
    // pending request's timeout.
    private fun sendTokenRequest(ctx: Context, scope: String, extras: Bundle) {
        val connection = object : ServiceConnection {
            private var done = false

            fun finish() {
                if (done) return
                done = true
                runCatching { ctx.unbindService(this) }
            }

            override fun onServiceConnected(name: ComponentName, binder: IBinder) {
                val replyTo = Messenger(object : Handler(Looper.getMainLooper()) {
                    override fun handleMessage(msg: Message) {
                        val data = msg.data
                        val reply = data.getBundle("data")
                        val registrationId = reply?.getString("registration_id")
                        when {
                            data.getBoolean("unsupported", false) ->
                                Log.e(TAG, "token request unsupported by Play Services")
                            registrationId != null -> onRegistration(ctx, registrationId)
                            else -> Log.w(TAG, "token reply without registration_id: ${reply ?: data}")
                        }
                        finish()
                    }
                })
                val msg = Message.obtain().apply {
                    what = OPCODE_SEND
                    arg1 = 1
                    this.replyTo = replyTo
                    data = Bundle().apply {
                        putBoolean("oneWay", false)
                        putString("pkg", ctx.packageName)
                        putBundle("data", extras)
                    }
                }
                runCatching { Messenger(binder).send(msg) }.onFailure { err ->
                    Log.e(TAG, "token request send failed for $scope", err)
                    finish()
                }
                mainHandler.postDelayed(::finish, REGISTRATION_TIMEOUT_MS)
            }

            override fun onServiceDisconnected(name: ComponentName) = Unit

            override fun onNullBinding(name: ComponentName) {
                Log.e(TAG, "Play Services returned a null binding for token requests")
                finish()
            }
        }
        val intent = Intent(ACTION_C2M_REGISTER).setPackage(GSF_PACKAGE)
        val bound = runCatching {
            ctx.bindService(intent, connection, Context.BIND_AUTO_CREATE)
        }.getOrElse { err ->
            Log.e(TAG, "binding Play Services token service failed", err)
            false
        }
        if (!bound) {
            Log.e(TAG, "Play Services token service not found")
            connection.finish()
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
