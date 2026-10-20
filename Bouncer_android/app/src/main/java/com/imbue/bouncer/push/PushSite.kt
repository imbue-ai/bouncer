package com.imbue.bouncer.push

import android.net.Uri

/**
 * The sites whose Web Push we turn on, and what differs between them. The
 * mechanism is the same for each: load the site's own push-settings page in a
 * hidden tab, click its toggle, let its handler subscribe (answered by
 * [BouncerPushDelegate]) and register the endpoint with its backend, then
 * render every later push natively ([NativePushHandler]).
 *
 * LinkedIn isn't here: its web client has no Web Push at all (no service
 * worker push handler, no pushManager use), so there is nothing to subscribe.
 */
enum class PushSite(
    /** Matches the Platforms id of the tab this site's feed lives in. */
    val platformId: String,
    /** Service-worker scope Gecko reports for the site's subscription. */
    val scope: String,
    /** Origin taps resolve against (payload URIs never leave it). */
    val origin: String,
    /** Page whose toggle turns push on for the logged-in account. */
    val settingsUrl: String,
    /**
     * Load the settings page as desktop Chrome. Facebook's mobile site has no
     * push setting, and its desktop page only hands out its VAPID key to the
     * browsers it knows; Chrome is the one verified to get it.
     */
    val desktopSettingsPage: Boolean,
    /** Shown when a push can't be decrypted or parsed. */
    val fallbackTitle: String,
    /** Tap target for a push that carries no URL. */
    val defaultUri: String,
) {
    X(
        platformId = "twitter",
        scope = "https://x.com/",
        origin = "https://x.com",
        settingsUrl = "https://x.com/settings/push_notifications",
        desktopSettingsPage = false,
        fallbackTitle = "X",
        defaultUri = "/notifications",
    ),
    FACEBOOK(
        platformId = "facebook",
        scope = "https://www.facebook.com/",
        origin = "https://www.facebook.com",
        settingsUrl = "https://www.facebook.com/settings/?tab=notifications",
        desktopSettingsPage = true,
        fallbackTitle = "Facebook",
        defaultUri = "/notifications",
    ),
    ;

    /** The authenticated feed: proof of login and the cue to auto-enable. */
    fun isHome(url: String): Boolean {
        val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return false
        val host = uri.host?.lowercase().orEmpty()
        val path = uri.path.orEmpty()
        return when (this) {
            X -> url.contains("x.com/home") || url.contains("twitter.com/home")
            FACEBOOK -> (host == "facebook.com" || host.endsWith(".facebook.com")) &&
                (path.isEmpty() || path == "/" || path == "/home.php")
        }
    }

    /**
     * Login / logout / checkpoint pages. Seeing one means the next feed may
     * be a freshly logged-in account, worth a new attempt. x.com's login is
     * tracked by the ViewModel's own hasLoggedIn logic instead.
     */
    fun isAuthFlow(url: String): Boolean {
        if (this != FACEBOOK) return false
        val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return false
        val host = uri.host?.lowercase().orEmpty()
        val path = uri.path.orEmpty()
        return (host == "facebook.com" || host.endsWith(".facebook.com")) &&
            (path.startsWith("/login") || path == "/logout.php" || path.startsWith("/checkpoint"))
    }

    companion object {
        // By host, so a worker registered under a sub-path scope still maps
        // back to its site.
        fun forScope(scope: String): PushSite? {
            val host = runCatching { Uri.parse(scope).host?.lowercase() }.getOrNull() ?: return null
            return entries.firstOrNull { Uri.parse(it.origin).host == host }
        }
        fun forPlatform(platformId: String): PushSite? = entries.firstOrNull { it.platformId == platformId }
    }
}
