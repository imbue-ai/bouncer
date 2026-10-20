package com.imbue.bouncer.push

import org.json.JSONObject
import java.net.URI

/**
 * The JSON x.com's push server puts inside a Web Push message. Mirrors the
 * schema x.com's own service worker (https://x.com/sw.js) validates against:
 *
 *   { title: string, body?: string, tag?: string, icon?: string,
 *     timestamp?: string|number,
 *     data?: { uri?: string, silent?: boolean, lang?: string,
 *              multi_title?: string, multi_body?: string, multi_uri?: string,
 *              bundle_text?, totalCount?, tweet_id?, user_id?, type?,
 *              impression_id?, scribe_target? } }
 *
 * The service worker shows nothing for `silent`, and when a notification with
 * the same `tag` is still open it re-renders with the `multi_*` ICU templates
 * ("{num_others} and X others liked…"). [NativePushHandler] replicates both so
 * notifications look the same as they would from Chrome, without Gecko.
 *
 * Facebook's messages are a different shape, mapped onto the same fields by
 * [parseFacebook].
 */
data class PushPayload(
    val title: String,
    val body: String?,
    val tag: String?,
    val iconUrl: String?,
    val uri: String?,
    val silent: Boolean,
    val lang: String?,
    val multiTitle: String?,
    val multiBody: String?,
    val multiUri: String?,
) {
    data class Rendered(val title: String, val body: String?, val uri: String?)

    /**
     * Text for the [count]-th notification shown under this tag (mirrors
     * sw.js B()). The first one uses the plain fields; later ones swap in the
     * multi_* templates, formatted by [format] with num_others / num_total.
     * A template that fails to format falls back to the plain field.
     */
    fun render(
        count: Int,
        format: (template: String, numOthers: Int, numTotal: Int) -> String?,
    ): Rendered {
        if (count <= 1) return Rendered(title, body, uri)
        val others = count - 1
        return Rendered(
            title = multiTitle?.let { format(it, others, count) } ?: title,
            body = multiBody?.let { format(it, others, count) } ?: body,
            uri = multiUri ?: uri,
        )
    }

    companion object {
        /** What sw.js shows when a message doesn't parse. */
        val FALLBACK = fallback(PushSite.X)

        /** What [site]'s worker shows when a message doesn't parse. */
        fun fallback(site: PushSite): PushPayload = PushPayload(
            title = site.fallbackTitle,
            body = "New notification",
            tag = "default",
            iconUrl = null,
            uri = site.defaultUri,
            silent = false,
            lang = null,
            multiTitle = null,
            multiBody = null,
            multiUri = null,
        )

        /** Null when the plaintext isn't [site]'s shape (caller shows [fallback]). */
        fun parse(plaintext: ByteArray?, site: PushSite = PushSite.X): PushPayload? {
            if (plaintext == null || plaintext.isEmpty()) return null
            val obj = runCatching { JSONObject(String(plaintext, Charsets.UTF_8)) }.getOrNull()
                ?: return null
            if (site == PushSite.FACEBOOK) return parseFacebook(obj)
            val title = obj.optStringOrNull("title") ?: return null
            val data = obj.optJSONObject("data")
            return PushPayload(
                title = title,
                body = obj.optStringOrNull("body"),
                tag = obj.optStringOrNull("tag"),
                iconUrl = obj.optStringOrNull("icon"),
                uri = data?.optStringOrNull("uri"),
                silent = data?.optBoolean("silent", false) ?: false,
                lang = data?.optStringOrNull("lang"),
                multiTitle = data?.optStringOrNull("multi_title"),
                multiBody = data?.optStringOrNull("multi_body"),
                multiUri = data?.optStringOrNull("multi_uri"),
            )
        }

        /**
         * Facebook's worker (ServiceWorkerPushEvent in its /sw?s=push bundle)
         * renders a message inline only when it carries a `type`:
         *
         *   { type, title?, message?, href?, ppu? | pic?, i? | t? (notif id),
         *     params?: { t_n? }, … }
         *
         * Anything else is a content-less "tickle" its worker resolves with a
         * cookie-authenticated fetch, which a native receiver can't make — so
         * those get the generic fallback, as its worker does when that fetch
         * fails. Each notification id is its own tag, so pushes stack rather
         * than replace one another.
         */
        private fun parseFacebook(obj: JSONObject): PushPayload? {
            if (obj.optStringOrNull("type") == null) return null
            val params = obj.optJSONObject("params")
            val title = obj.optStringOrNull("title")?.takeIf { it.isNotEmpty() }
                ?: params?.optStringOrNull("t_n")
                ?: PushSite.FACEBOOK.fallbackTitle
            val id = obj.opt("i")?.takeUnless { obj.isNull("i") }
                ?: obj.opt("t")?.takeUnless { obj.isNull("t") }
            return PushPayload(
                title = title,
                body = obj.optStringOrNull("message"),
                tag = id?.let { "fb_$it" },
                iconUrl = obj.optStringOrNull("ppu") ?: obj.optStringOrNull("pic"),
                uri = obj.optStringOrNull("href"),
                silent = false,
                lang = null,
                multiTitle = null,
                multiBody = null,
                multiUri = null,
            )
        }

        /**
         * The page a tap opens. Mirrors sw.js W(): resolve `uri` against the
         * site's origin and keep only path + query, so a payload can never
         * steer the tap off-origin (an absolute foreign URL collapses to its
         * path on that origin) and an unparseable one lands on the default.
         */
        fun resolveClickUrl(uri: String?, site: PushSite = PushSite.X): String {
            val origin = site.origin
            val target = uri?.trim()?.takeIf { it.isNotEmpty() } ?: site.defaultUri
            val resolved = runCatching { URI("$origin/").resolve(URI(target)) }.getOrNull()
                ?: return origin + site.defaultUri
            val path = resolved.rawPath?.takeIf { it.isNotEmpty() } ?: "/"
            val query = resolved.rawQuery?.let { "?$it" }.orEmpty()
            return origin + path + query
        }

        private fun JSONObject.optStringOrNull(key: String): String? =
            if (isNull(key)) null else opt(key) as? String
    }
}
