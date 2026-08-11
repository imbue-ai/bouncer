package com.imbue.bouncer.push

import android.content.Context
import android.util.Log
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.WebPushDelegate
import org.mozilla.geckoview.WebPushSubscription

/**
 * Answers pushManager.subscribe/getSubscription/unsubscribe from web content.
 * We are the "browser" side of Web Push: for each subscription we mint a P-256
 * keypair + auth secret (held by [PushSubscriptionStore], decrypted by
 * [WebPushCrypto]) and a real fcm.googleapis.com endpoint via [PushRegistrar].
 */
class BouncerPushDelegate(private val appCtx: Context) : WebPushDelegate {

    private val store = PushSubscriptionStore(appCtx)

    override fun onSubscribe(
        scope: String,
        appServerKey: ByteArray?,
    ): GeckoResult<WebPushSubscription>? {
        Log.i(TAG, "onSubscribe: $scope")
        return PushRegistrar.subscribe(appCtx, scope, appServerKey)
    }

    override fun onGetSubscription(scope: String): GeckoResult<WebPushSubscription>? =
        GeckoResult.fromValue(
            store.get(scope)?.let {
                // appServerKey deliberately null: GeckoView's getSubscription
                // path mangles a returned key into a garbage ArrayBuffer on
                // the page; Firefox for Android returns null here too.
                WebPushSubscription(scope, it.endpoint, null, it.publicKeyUncompressed, it.authSecret)
            },
        )

    override fun onUnsubscribe(scope: String): GeckoResult<Void> {
        Log.i(TAG, "onUnsubscribe: $scope")
        // The wp: registration itself is simply abandoned (there is no GMS
        // deletion API on this path); dropping the record makes future pushes
        // to the stale endpoint no-ops.
        store.remove(scope)
        return GeckoResult.fromValue(null)
    }

    companion object {
        private const val TAG = "FF/WebPush"
    }
}
