package com.imbue.bouncer.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PushPayloadTest {

    private fun bytes(s: String) = s.toByteArray(Charsets.UTF_8)

    // The shape x.com's push server actually sends (fields per sw.js schema).
    private val full = """
        {"title":"Alice liked your post",
         "body":"hello world",
         "tag":"rweb_favorite_123",
         "icon":"https://pbs.twimg.com/profile_images/1/a_normal.jpg",
         "timestamp":1700000000000,
         "data":{"uri":"/alice/status/123?s=20",
                 "silent":false,
                 "lang":"en",
                 "multi_title":"Alice and {num_others, plural, one {# other} other {# others}} liked your post",
                 "multi_body":"{num_total} likes",
                 "multi_uri":"/notifications",
                 "scribe_target":"favorite",
                 "tweet_id":"123","user_id":"42","type":"favorite",
                 "impression_id":"abc"}}
    """.trimIndent()

    @Test
    fun parsesFullPayload() {
        val p = PushPayload.parse(bytes(full))
        assertNotNull(p)
        p!!
        assertEquals("Alice liked your post", p.title)
        assertEquals("hello world", p.body)
        assertEquals("rweb_favorite_123", p.tag)
        assertEquals("https://pbs.twimg.com/profile_images/1/a_normal.jpg", p.iconUrl)
        assertEquals("/alice/status/123?s=20", p.uri)
        assertFalse(p.silent)
        assertEquals("en", p.lang)
        assertEquals("{num_total} likes", p.multiBody)
        assertEquals("/notifications", p.multiUri)
    }

    @Test
    fun parsesMinimalPayload() {
        val p = PushPayload.parse(bytes("""{"title":"Hi"}"""))
        assertNotNull(p)
        assertEquals("Hi", p!!.title)
        assertNull(p.body)
        assertNull(p.tag)
        assertNull(p.uri)
        assertFalse(p.silent)
    }

    @Test
    fun silentFlagIsRead() {
        val p = PushPayload.parse(bytes("""{"title":"x","data":{"silent":true}}"""))
        assertTrue(p!!.silent)
    }

    @Test
    fun nullFieldsAreTreatedAsAbsent() {
        val p = PushPayload.parse(bytes("""{"title":"x","body":null,"data":{"uri":null}}"""))
        assertNull(p!!.body)
        assertNull(p.uri)
    }

    @Test
    fun rejectsThingsThatAreNotTheXShape() {
        assertNull(PushPayload.parse(null))
        assertNull(PushPayload.parse(ByteArray(0)))
        assertNull(PushPayload.parse(bytes("not json")))
        assertNull(PushPayload.parse(bytes("""{"body":"no title"}""")))
        assertNull(PushPayload.parse(bytes("""{"title":123}""")))
        assertNull(PushPayload.parse(bytes("""[1,2,3]""")))
    }

    @Test
    fun fallbackMatchesServiceWorkerDefault() {
        assertEquals("X", PushPayload.FALLBACK.title)
        assertEquals("New notification", PushPayload.FALLBACK.body)
        assertEquals("default", PushPayload.FALLBACK.tag)
        assertEquals("https://x.com/notifications", PushPayload.resolveClickUrl(PushPayload.FALLBACK.uri))
    }

    @Test
    fun clickUrlResolvesAgainstXAndKeepsOnlyPathAndQuery() {
        assertEquals("https://x.com/notifications", PushPayload.resolveClickUrl(null))
        assertEquals("https://x.com/notifications", PushPayload.resolveClickUrl("   "))
        assertEquals("https://x.com/i/chat", PushPayload.resolveClickUrl("/i/chat"))
        assertEquals("https://x.com/alice/status/123?s=20", PushPayload.resolveClickUrl("/alice/status/123?s=20"))
        assertEquals("https://x.com/foo?x=1", PushPayload.resolveClickUrl("/foo?x=1#frag"))
        assertEquals("https://x.com/notifications", PushPayload.resolveClickUrl("notifications"))
        // Absolute / protocol-relative URLs can't steer the tap off x.com.
        assertEquals("https://x.com/bar?q=1", PushPayload.resolveClickUrl("https://evil.example/bar?q=1"))
        assertEquals("https://x.com/x", PushPayload.resolveClickUrl("//evil.example/x"))
        // Opaque or unparseable URIs land somewhere harmless.
        assertEquals("https://x.com/", PushPayload.resolveClickUrl("javascript:alert(1)"))
        assertEquals("https://x.com/notifications", PushPayload.resolveClickUrl("http://[bad"))
    }

    @Test
    fun firstNotificationUnderATagUsesPlainFields() {
        val p = PushPayload.parse(bytes(full))!!
        val r = p.render(1) { _, _, _ -> error("template must not be formatted for count=1") }
        assertEquals("Alice liked your post", r.title)
        assertEquals("hello world", r.body)
        assertEquals("/alice/status/123?s=20", r.uri)
    }

    @Test
    fun laterNotificationsUnderATagUseMultiTemplates() {
        val p = PushPayload.parse(bytes(full))!!
        val r = p.render(3) { template, others, total -> "$template|$others|$total" }
        assertEquals(
            "Alice and {num_others, plural, one {# other} other {# others}} liked your post|2|3",
            r.title,
        )
        assertEquals("{num_total} likes|2|3", r.body)
        assertEquals("/notifications", r.uri)
    }

    @Test
    fun bundledRenderFallsBackWhenTemplatesAreMissingOrFail() {
        val noTemplates = PushPayload.parse(bytes("""{"title":"T","body":"B","tag":"t","data":{"uri":"/u"}}"""))!!
        val r1 = noTemplates.render(2) { _, _, _ -> "unused" }
        assertEquals("T", r1.title)
        assertEquals("B", r1.body)
        assertEquals("/u", r1.uri)

        val p = PushPayload.parse(bytes(full))!!
        val r2 = p.render(2) { _, _, _ -> null } // formatter rejected the template
        assertEquals("Alice liked your post", r2.title)
        assertEquals("hello world", r2.body)
    }

    // Field names from Facebook's worker (ServiceWorkerPushEvent); values invented.
    @Test
    fun parsesFacebookInlinePayload() {
        val p = PushPayload.parse(
            bytes(
                """{"type":"comment","title":"Bob commented on your post","message":"nice!",
                    "href":"https://www.facebook.com/permalink.php?story_fbid=1&id=2",
                    "ppu":"https://scontent.xx.fbcdn.net/bob.jpg","pic":"https://x/pic.jpg",
                    "i":12345,"time":1700000000}""",
            ),
            PushSite.FACEBOOK,
        )!!
        assertEquals("Bob commented on your post", p.title)
        assertEquals("nice!", p.body)
        assertEquals("fb_12345", p.tag)
        assertEquals("https://scontent.xx.fbcdn.net/bob.jpg", p.iconUrl)
        assertFalse(p.silent)
        assertEquals(
            "https://www.facebook.com/permalink.php?story_fbid=1&id=2",
            PushPayload.resolveClickUrl(p.uri, PushSite.FACEBOOK),
        )
    }

    @Test
    fun facebookTitleFallsBackToParamsThenSiteName() {
        val fromParams = PushPayload.parse(
            bytes("""{"type":"cm","title":"","params":{"t_n":"Group chat"}}"""),
            PushSite.FACEBOOK,
        )!!
        assertEquals("Group chat", fromParams.title)
        val bare = PushPayload.parse(bytes("""{"type":"x"}"""), PushSite.FACEBOOK)!!
        assertEquals("Facebook", bare.title)
        assertNull(bare.tag)
    }

    @Test
    fun facebookTickleWithoutTypeIsNotInline() {
        // No `type`: its worker would fetch the content with cookies.
        assertNull(PushPayload.parse(bytes("""{"title":"t","message":"m"}"""), PushSite.FACEBOOK))
        assertEquals("Facebook", PushPayload.fallback(PushSite.FACEBOOK).title)
        assertEquals(
            "https://www.facebook.com/notifications",
            PushPayload.resolveClickUrl(null, PushSite.FACEBOOK),
        )
        assertEquals(
            "https://www.facebook.com/x",
            PushPayload.resolveClickUrl("https://evil.example/x", PushSite.FACEBOOK),
        )
    }
}
