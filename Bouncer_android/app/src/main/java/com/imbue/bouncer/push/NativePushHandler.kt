package com.imbue.bouncer.push

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.icu.text.MessageFormat
import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.core.app.NotificationCompat
import com.imbue.bouncer.MainActivity
import com.imbue.bouncer.R
import okhttp3.OkHttpClient
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Turns a decrypted x.com Web Push message into an Android notification
 * directly, so a push never has to boot Gecko.
 *
 * Previously the receiver handed the plaintext to GeckoRuntime, whose only job
 * was to run x.com's service worker `push` handler — which parses the JSON,
 * applies a couple of display rules, and calls showNotification. Doing that
 * in-process cost a full browser cold start (main + gpu/socket/utility/content
 * processes + extension install) per notification, which dominated the app's
 * background battery use. This class is a faithful port of that handler:
 *
 *  - payload shape and fallback: [PushPayload]
 *  - `data.silent` → show nothing
 *  - same-tag bundling: the n-th open notification under a tag re-renders
 *    with the multi_* ICU templates; the running count rides along in the
 *    notification extras so it survives us being restarted between pushes
 *  - tap → the resolved x.com URL, opened in the X tab by [MainActivity]
 *
 * Icon fetch + post run off the main thread under the receiver's goAsync()
 * window, so the caller must invoke the completion callback exactly once.
 */
class NativePushHandler(private val appCtx: Context) {

    private val client = OkHttpClient.Builder()
        .callTimeout(ICON_TIMEOUT_S, TimeUnit.SECONDS)
        .build()

    fun deliver(scope: String, plaintext: ByteArray?, onDone: () -> Unit) {
        executor.execute {
            try {
                deliverBlocking(scope, plaintext)
            } catch (e: Exception) {
                Log.e(TAG, "native push delivery failed for $scope", e)
            } finally {
                onDone()
            }
        }
    }

    private fun deliverBlocking(scope: String, plaintext: ByteArray?) {
        val payload = PushPayload.parse(plaintext) ?: run {
            Log.w(TAG, "unparseable push payload (${plaintext?.size ?: 0} bytes); showing generic")
            PushPayload.FALLBACK
        }
        if (payload.silent) {
            Log.i(TAG, "silent push for $scope; not displaying")
            return
        }
        if (!WebNotificationHandler.notificationsEnabled(appCtx)) {
            // App-level toggle off: keep the subscription alive, just don't show.
            Log.i(TAG, "notifications off at app level; suppressing display")
            return
        }
        WebNotificationHandler.ensureChannel(appCtx)
        val tag = payload.tag ?: scope
        val count = openCount(tag) + 1
        val rendered = payload.render(count) { template, others, total ->
            formatTemplate(template, payload.lang, others, total)
        }
        val icon = payload.iconUrl?.let { WebNotificationHandler.fetchBitmap(client, it) }
        val clickUrl = PushPayload.resolveClickUrl(rendered.uri)
        Log.i(TAG, "posting notification tag=$tag count=$count url=$clickUrl icon=${icon != null}")
        post(tag, rendered, icon, clickUrl, count)
    }

    // How many pushes the notification currently showing under this tag
    // already represents (0 if none is showing).
    private fun openCount(tag: String): Int = runCatching {
        WebNotificationHandler.manager(appCtx).activeNotifications
            .firstOrNull { it.tag == tag && it.id == WebNotificationHandler.NOTIFICATION_ID }
            ?.notification?.extras?.getInt(EXTRA_TOTAL_COUNT, 0) ?: 0
    }.getOrDefault(0)

    // x.com's multi_* templates are ICU MessageFormat ("{num_others, plural,
    // one {# other} other {# others}}"); android.icu handles them natively.
    private fun formatTemplate(template: String, lang: String?, numOthers: Int, numTotal: Int): String? =
        runCatching {
            val locale = lang?.let { Locale.forLanguageTag(it) } ?: Locale.getDefault()
            MessageFormat(template, locale).format(
                mapOf<String, Any>("num_others" to numOthers, "num_total" to numTotal),
            )
        }.onFailure { Log.w(TAG, "template format failed: $template", it) }.getOrNull()

    private fun post(
        tag: String,
        rendered: PushPayload.Rendered,
        icon: Bitmap?,
        clickUrl: String,
        count: Int,
    ) {
        val clickIntent = Intent(appCtx, MainActivity::class.java).apply {
            action = ACTION_OPEN_URL
            // Unique data URI per tag so PendingIntents for different
            // notifications don't collapse into one another; same tag updates
            // in place (FLAG_UPDATE_CURRENT) alongside the replaced notification.
            data = Uri.parse("bouncer-notification://$tag")
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(EXTRA_URL, clickUrl)
        }
        val pending = PendingIntent.getActivity(
            appCtx,
            0,
            clickIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(appCtx, WebNotificationHandler.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_bouncer)
            .setContentTitle(rendered.title)
            .setContentText(rendered.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(rendered.body))
            .setAutoCancel(true)
            .setContentIntent(pending)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .addExtras(Bundle().apply { putInt(EXTRA_TOTAL_COUNT, count) })
        icon?.let { builder.setLargeIcon(it) }
        runCatching {
            WebNotificationHandler.manager(appCtx)
                .notify(tag, WebNotificationHandler.NOTIFICATION_ID, builder.build())
        }.onFailure {
            // POST_NOTIFICATIONS revoked; nothing to do.
            Log.w(TAG, "notify failed", it)
        }
    }

    companion object {
        private const val TAG = "FF/NativePush"
        private const val ICON_TIMEOUT_S = 4L
        private const val EXTRA_TOTAL_COUNT = "com.imbue.bouncer.push.totalCount"
        const val ACTION_OPEN_URL = "com.imbue.bouncer.PUSH_OPEN_URL"
        const val EXTRA_URL = "push_url"

        // One worker for all deliveries: pushes are rare and serializing them
        // keeps the same-tag count read/write race-free.
        private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "bouncer-push") }
    }
}
