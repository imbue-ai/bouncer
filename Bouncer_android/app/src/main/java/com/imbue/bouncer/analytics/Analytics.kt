package com.imbue.bouncer.analytics

import android.content.Context
import androidx.core.app.NotificationManagerCompat
import androidx.core.os.bundleOf
import com.google.firebase.analytics.FirebaseAnalytics
import com.imbue.bouncer.push.PushSubscriptionStore
import com.imbue.bouncer.push.WebNotificationHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Firebase Analytics wrapper. Exists first and foremost to answer "how many
 * users actually have notifications enabled?" — nothing reports that for us:
 * push here is raw GSF web push (see PushRegistrar) with x.com as the sender,
 * so it never shows up in FCM's delivery dashboards, and Play Console has no
 * permission metrics at all.
 *
 * "Enabled" is three independent switches, reported as separate user
 * properties so audiences can slice on each:
 *  - [PROP_OS_ENABLED]: Android will actually display our notifications —
 *    NotificationManagerCompat.areNotificationsEnabled(), which covers both
 *    the POST_NOTIFICATIONS grant and the app being muted in system settings.
 *  - [PROP_APP_TOGGLE]: the in-app settings toggle. Off only suppresses
 *    display (WebNotificationHandler); the subscription stays live.
 *  - [PROP_PUSH_SUBSCRIBED]: an x.com web-push subscription exists, i.e.
 *    x.com's backend is registered to send us pushes.
 */
object Analytics {

    // Refreshing reads EncryptedSharedPreferences (keystore + disk), so it
    // never runs on the caller's thread.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile
    private var firebase: FirebaseAnalytics? = null

    /** Main-process only; no-op everywhere else (fields stay null → events drop). */
    fun init(ctx: Context) {
        firebase = FirebaseAnalytics.getInstance(ctx.applicationContext)
    }

    /**
     * Outcome of the OS POST_NOTIFICATIONS dialog. [source] is which of the
     * three ask sites fired it: "onboarding" (pre-login early ask),
     * "timeline_fallback" (auto-enable on reaching home), or "settings"
     * (user flipped the toggle on while unpermitted).
     */
    fun logNotificationPermissionResult(ctx: Context, source: String, granted: Boolean) {
        firebase?.logEvent(
            "notif_permission_result",
            bundleOf("source" to source, "granted" to granted.toString()),
        )
        refreshNotificationStatus(ctx)
    }

    /** The x.com web-push subscription registered (the auto-enable flow succeeded). */
    fun logPushSubscribed(ctx: Context) {
        firebase?.logEvent("push_subscribed", null)
        refreshNotificationStatus(ctx)
    }

    /** The in-app notifications display toggle changed. */
    fun logNotificationsToggled(ctx: Context, on: Boolean) {
        firebase?.logEvent(
            "notif_toggle_changed",
            bundleOf("on" to on.toString()),
        )
        refreshNotificationStatus(ctx)
    }

    /**
     * Recompute the three user properties and log a snapshot event. Called on
     * every app start (so the properties track drift like the user muting the
     * app in system settings) and after each state change above.
     */
    fun refreshNotificationStatus(ctx: Context) {
        val fa = firebase ?: return
        val appCtx = ctx.applicationContext
        scope.launch {
            val osEnabled = NotificationManagerCompat.from(appCtx).areNotificationsEnabled()
            val prefs = appCtx.getSharedPreferences(WebNotificationHandler.PREFS, Context.MODE_PRIVATE)
            val appToggle = when {
                !prefs.contains(WebNotificationHandler.KEY_NOTIFICATIONS_ON) -> "unset"
                prefs.getBoolean(WebNotificationHandler.KEY_NOTIFICATIONS_ON, true) -> "on"
                else -> "off"
            }
            // Same scope key the enable flow uses (BouncerViewModel).
            val subscribed = runCatching {
                PushSubscriptionStore(appCtx).get("https://x.com/") != null
            }.getOrDefault(false)

            fa.setUserProperty(PROP_OS_ENABLED, osEnabled.toString())
            fa.setUserProperty(PROP_APP_TOGGLE, appToggle)
            fa.setUserProperty(PROP_PUSH_SUBSCRIBED, subscribed.toString())
            // Event twin of the properties: event counts are visible in the
            // Firebase console without registering custom dimensions first.
            fa.logEvent(
                "notif_status",
                bundleOf(
                    "os_enabled" to osEnabled.toString(),
                    "app_toggle" to appToggle,
                    "push_subscribed" to subscribed.toString(),
                ),
            )
        }
    }

    const val PROP_OS_ENABLED = "notif_os_enabled"
    const val PROP_APP_TOGGLE = "notif_app_toggle"
    const val PROP_PUSH_SUBSCRIBED = "push_subscribed"
}
