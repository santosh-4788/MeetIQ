package com.oneinsure.connect

import com.oneinsure.connect.UrlPolicy.Action
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UrlPolicyTest {
    private val host = "www.oneinsure.com"
    private val path = "/meet"
    private fun c(url: String?) = UrlPolicy.classify(url, host, path)

    @Test fun portal_pages_open_inside() {
        assertEquals(Action.INSIDE, c("https://www.oneinsure.com/meet/"))
        assertEquals(Action.INSIDE, c("https://www.oneinsure.com/meet"))
        assertEquals(Action.INSIDE, c("https://www.oneinsure.com/meet/m/Xk3_p9QaZ1bT7wLmA8c-Rr"))
        assertEquals(Action.INSIDE, c("https://www.oneinsure.com/meet/join/abc?x=1#y"))
        assertEquals(Action.INSIDE, c("https://WWW.ONEINSURE.COM/meet/dashboard"))
        assertEquals(Action.INSIDE, c("https://www.oneinsure.com:443/meet/"))
    }

    @Test fun look_alikes_and_other_sites_open_outside() {
        assertEquals(Action.OUTSIDE, c("https://www.oneinsure.com/meeting-evil"))
        assertEquals(Action.OUTSIDE, c("https://www.oneinsure.com/"))
        assertEquals(Action.OUTSIDE, c("https://www.oneinsure.com.evil.com/meet/"))
        assertEquals(Action.OUTSIDE, c("https://evil.com/meet/"))
        assertEquals(Action.OUTSIDE, c("https://oneinsure.com/meet/")) // only the exact portal host is "inside"
        assertEquals(Action.OUTSIDE, c("http://www.oneinsure.com/meet/")) // never plain http inside the app
        assertEquals(Action.OUTSIDE, c("https://www.oneinsure.com:8443/meet/"))
        assertEquals(Action.OUTSIDE, c("https://user:pw@www.oneinsure.com/meet/"))
        assertEquals(Action.OUTSIDE, c("https://www.oneinsure.com/meet/../admin"))
        assertEquals(Action.OUTSIDE, c("https://www.oneinsure.com/meet/%2e%2e/admin"))
        assertEquals(Action.OUTSIDE, c("https://wa.me/919876543210?text=hi"))
        assertEquals(Action.OUTSIDE, c("mailto:a@b.com"))
        assertEquals(Action.OUTSIDE, c("tel:+919876543210"))
    }

    @Test fun dangerous_schemes_are_blocked() {
        assertEquals(Action.BLOCK, c("javascript:alert(1)"))
        assertEquals(Action.BLOCK, c("file:///sdcard/x"))
        assertEquals(Action.BLOCK, c("data:text/html,<b>x</b>"))
        assertEquals(Action.BLOCK, c("content://x/y"))
        assertEquals(Action.BLOCK, c("intent://scan/#Intent;scheme=zxing;end"))
        assertEquals(Action.BLOCK, c(""))
        assertEquals(Action.BLOCK, c(null))
        assertEquals(Action.BLOCK, c("not a url with spaces ::"))
    }

    @Test fun screen_goes_only_to_our_video_server() {
        assertTrue(UrlPolicy.isOurVideoServer("wss://www.oneinsure.com/meet/", host))
        assertTrue(UrlPolicy.isOurVideoServer("wss://www.oneinsure.com:443/meet/rtc", host))
        assertFalse(UrlPolicy.isOurVideoServer("ws://www.oneinsure.com/meet/", host))
        assertFalse(UrlPolicy.isOurVideoServer("wss://evil.com/meet/", host))
        assertFalse(UrlPolicy.isOurVideoServer("wss://www.oneinsure.com.evil.com/", host))
        assertFalse(UrlPolicy.isOurVideoServer("wss://www.oneinsure.com:7880/", host))
        assertFalse(UrlPolicy.isOurVideoServer("https://www.oneinsure.com/meet/", host))
        assertFalse(UrlPolicy.isOurVideoServer(null, host))
    }

    @Test fun token_shape() {
        assertTrue(UrlPolicy.looksLikeAccessToken("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwXzEifQ.abcdefghijklmnopqrstuvwxyz012345"))
        assertFalse(UrlPolicy.looksLikeAccessToken("abc"))
        assertFalse(UrlPolicy.looksLikeAccessToken("a.b.c"))
        assertFalse(UrlPolicy.looksLikeAccessToken("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwXzEifQ.abc<script>defghijklmnopq"))
        assertFalse(UrlPolicy.looksLikeAccessToken(null))
        assertFalse(UrlPolicy.looksLikeAccessToken("a".repeat(5000)))
    }

    @Test fun portal_check_for_the_calling_page() {
        assertTrue(UrlPolicy.isPortalUrl("https://www.oneinsure.com/meet/meetings/1/room", host, path))
        assertFalse(UrlPolicy.isPortalUrl("https://evil.com/meet/", host, path))
        assertFalse(UrlPolicy.isPortalUrl(null, host, path))
    }

    @Test fun names_and_file_names_are_cleaned() {
        assertEquals("Akshay kumar", UrlPolicy.safeName("Akshay kumar"))
        assertEquals("scriptalert1script", UrlPolicy.safeName("<script>alert(1)</script>"))
        assertEquals(60, UrlPolicy.safeName("x".repeat(200)).length)
        assertEquals("report.csv", UrlPolicy.safeFileName("../../report.csv"))
        assertEquals("passwd", UrlPolicy.safeFileName("/etc/passwd"))
        assertEquals("download", UrlPolicy.safeFileName("..."))
        assertEquals("Minutes (1).pdf", UrlPolicy.safeFileName("Minutes (1).pdf"))
    }
}
