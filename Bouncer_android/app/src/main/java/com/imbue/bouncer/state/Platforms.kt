package com.imbue.bouncer.state

import android.net.Uri

/**
 * Platforms the Android app can show in the feed, mirroring the iOS
 * `Platforms` registry. Only entries whose adapter + host allowlist + content
 * scripts actually ship on the Gecko build belong here — the dropdown must
 * never offer a platform the pipeline can't filter.
 *
 * Mirrors the iOS Platforms registry. Each entry's adapter + host allowlist +
 * content scripts must actually ship on the Gecko build (host allowlist in
 * BouncerGeckoView + content_scripts match in web_ext_gecko/manifest.json).
 */
data class Platform(
    val id: String,
    val displayName: String,
    val feedUrl: String,
    private val hostRoots: List<String>,
) {
    fun matches(host: String): Boolean {
        val h = host.lowercase()
        return hostRoots.any { h == it || h.endsWith(".$it") }
    }
}

object Platforms {
    val all: List<Platform> = listOf(
        Platform(
            id = "twitter",
            displayName = "X (Twitter)",
            feedUrl = "https://x.com/home",
            hostRoots = listOf("x.com", "twitter.com"),
        ),
        Platform(
            id = "linkedin",
            displayName = "LinkedIn",
            feedUrl = "https://www.linkedin.com/feed/",
            hostRoots = listOf("linkedin.com"),
        ),
    )

    fun byId(id: String): Platform? = all.firstOrNull { it.id == id }

    /** Which platform "owns" the currently-loaded URL, for the selector's label. */
    fun fromUrl(url: String): Platform? {
        val host = runCatching { Uri.parse(url).host }.getOrNull()?.lowercase() ?: return null
        return all.firstOrNull { it.matches(host) }
    }
}
