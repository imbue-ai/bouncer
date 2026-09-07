package com.imbue.bouncer.push

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import androidx.core.app.NotificationCompat
import com.imbue.bouncer.MainActivity
import com.imbue.bouncer.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import org.mozilla.geckoview.WebNotification
import org.mozilla.geckoview.WebNotificationDelegate
import java.util.concurrent.TimeUnit

/**
 * Surfaces service-worker notifications (registration.showNotification from
 * x.com's SW) as Android notifications. Clicks route back through
 * MainActivity, which calls WebNotification.click() so the site's
 * notificationclick handler runs and can open the right page.
 */
class WebNotificationHandler(
    private val appCtx: Context,
    private val scope: CoroutineScope,
) : WebNotificationDelegate {

    private val client = OkHttpClient.Builder()
        .callTimeout(5, TimeUnit.SECONDS)
        .build()

    override fun onShowNotification(notification: WebNotification) {
        Log.i(TAG, "onShowNotification from ${notification.source ?: notification.origin}")
        if (!notificationsEnabled()) {
            // Suppressed at the app level: keep the subscription + permission
            // intact (so x.com keeps sending), just don't surface it on Android.
            // Still ack the service worker so its showNotification bookkeeping
            // resolves and it keeps delivering.
            Log.i(TAG, "notifications off at app level; suppressing display")
            scope.launch(Dispatchers.Main) { notification.show() }
            return
        }
        ensureChannel()
        // The web icon (e.g. the sender's avatar) needs a network fetch; post
        // the notification from a coroutine once that resolves either way.
        scope.launch(Dispatchers.IO) {
            val icon = notification.imageUrl?.let { fetchBitmap(it) }
            val shown = notify(notification, icon)
            // Ack display back to content (resolves showNotification bookkeeping).
            launch(Dispatchers.Main) {
                if (shown) notification.show() else notification.dismiss()
            }
        }
    }

    override fun onCloseNotification(notification: WebNotification) {
        manager().cancel(tagFor(notification), NOTIFICATION_ID)
    }

    private fun notify(webNotification: WebNotification, icon: Bitmap?): Boolean {
        val clickIntent = Intent(appCtx, MainActivity::class.java).apply {
            action = ACTION_CLICK
            // Unique data URI so PendingIntents for different notifications
            // don't collapse into one another.
            data = android.net.Uri.parse("bouncer-notification://${tagFor(webNotification)}")
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(EXTRA_NOTIFICATION, webNotification)
        }
        val pending = PendingIntent.getActivity(
            appCtx,
            0,
            clickIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(appCtx, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_bouncer)
            .setContentTitle(webNotification.title ?: "X")
            .setContentText(webNotification.text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(webNotification.text))
            .setAutoCancel(true)
            .setContentIntent(pending)
            .setSilent(webNotification.silent)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
        icon?.let { builder.setLargeIcon(it) }
        return runCatching {
            manager().notify(tagFor(webNotification), NOTIFICATION_ID, builder.build())
        }.onFailure {
            // POST_NOTIFICATIONS revoked mid-flight; nothing to do.
            Log.w(TAG, "notify failed", it)
        }.isSuccess
    }

    private fun fetchBitmap(url: String): Bitmap? = runCatching {
        client.newCall(Request.Builder().url(url).build()).execute().use { response ->
            if (!response.isSuccessful) return null
            response.body?.bytes()?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
        }
    }.onFailure { Log.w(TAG, "icon fetch failed: $url", it) }.getOrNull()

    // The site's tag dedupes replacement notifications (x.com reuses tags to
    // update a thread) and is stable across the show/close callback pair.
    private fun tagFor(n: WebNotification): String = n.tag ?: n.origin.orEmpty()

    // App-level display switch (the settings sheet's "Push notifications" toggle).
    // Independent of the subscription/permission — off just hides notifications.
    private fun notificationsEnabled(): Boolean =
        appCtx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(KEY_NOTIFICATIONS_ON, true)

    private fun manager(): NotificationManager =
        appCtx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun ensureChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Website notifications",
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply { description = "Notifications from x.com" }
        manager().createNotificationChannel(channel)
    }

    companion object {
        private const val TAG = "FF/WebNotification"
        // Shared with BouncerViewModel — the settings toggle writes this key.
        const val PREFS = "bouncer_prefs"
        const val KEY_NOTIFICATIONS_ON = "notificationsOn"
        const val CHANNEL_ID = "web_notifications"
        const val ACTION_CLICK = "com.imbue.bouncer.WEB_NOTIFICATION_CLICK"
        const val EXTRA_NOTIFICATION = "web_notification"
        const val NOTIFICATION_ID = 7001
    }
}
