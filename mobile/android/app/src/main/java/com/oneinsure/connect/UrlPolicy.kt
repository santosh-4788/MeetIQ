package com.oneinsure.connect

import java.net.URI

/**
 * What the app may load and hand over. Pure Kotlin (no Android types) so it is unit-tested on the JVM.
 *
 * - Only https://<portal host><portal path>… is shown inside the app (the OneInsure Connect portal).
 * - Other web links, e-mail, phone and WhatsApp links open outside the app; javascript:, file:, data:, content:,
 *   intent: and anything unknown are blocked.
 * - The phone screen may only be sent to OUR video server: wss://<portal host>/… with a well-formed access token.
 */
object UrlPolicy {
    enum class Action { INSIDE, OUTSIDE, BLOCK }

    private val outsideSchemes = setOf("mailto", "tel", "sms", "whatsapp")

    fun classify(url: String?, host: String, pathPrefix: String): Action {
        if (url.isNullOrBlank()) return Action.BLOCK
        val uri = parse(url) ?: return Action.BLOCK
        val scheme = uri.scheme?.lowercase() ?: return Action.BLOCK
        return when {
            scheme == "https" && isPortal(uri, host, pathPrefix) -> Action.INSIDE
            scheme == "https" || scheme == "http" -> Action.OUTSIDE
            scheme in outsideSchemes -> Action.OUTSIDE
            else -> Action.BLOCK // javascript:, file:, data:, content:, intent:, blob: (handled separately) ...
        }
    }

    /** The page calling the bridge must be the portal itself (not an embedded or redirected page). */
    fun isPortalUrl(url: String?, host: String, pathPrefix: String): Boolean {
        val uri = parse(url ?: return false) ?: return false
        return uri.scheme.equals("https", ignoreCase = true) && isPortal(uri, host, pathPrefix)
    }

    private fun isPortal(uri: URI, host: String, pathPrefix: String): Boolean {
        if (!uri.host.equals(host, ignoreCase = true)) return false
        if (uri.port != -1 && uri.port != 443) return false
        if (uri.rawUserInfo != null) return false
        val path = uri.rawPath ?: ""
        // "/meet" itself or "/meet/..." - never "/meeting-evil" or a path that climbs out with ".."
        if (path.contains("..") || path.contains("%2e", ignoreCase = true)) return false
        return path == pathPrefix || path.startsWith("$pathPrefix/")
    }

    /** The video server the phone screen is sent to: our host only, secure WebSocket, default port. */
    fun isOurVideoServer(url: String?, host: String): Boolean {
        val uri = parse(url ?: return false) ?: return false
        return uri.scheme.equals("wss", ignoreCase = true) && uri.host.equals(host, ignoreCase = true) &&
            (uri.port == -1 || uri.port == 443) && uri.rawUserInfo == null
    }

    private val jwt = Regex("^[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{20,}$")

    /** A LiveKit access token's shape (header.payload.signature); the server checks the signature. */
    fun looksLikeAccessToken(token: String?): Boolean = token != null && token.length <= 4096 && jwt.matches(token)

    /** Display name of the presenter for the notification: plain text, short. */
    fun safeName(name: String?): String =
        (name ?: "").filter { it.isLetterOrDigit() || it == ' ' || it == '.' || it == '-' || it == '\'' }.trim().take(60)

    /** File name for a download: no folders, no control characters, keeps the extension. */
    fun safeFileName(name: String?, fallback: String = "download"): String {
        val base = (name ?: "").substringAfterLast('/').substringAfterLast('\\')
            .filter { it.isLetterOrDigit() || it in " ._-()" }.trim().trimStart('.')
        return base.take(120).ifBlank { fallback }
    }

    private fun parse(url: String): URI? = try {
        URI(url.trim())
    } catch (_: Exception) {
        null
    }
}
