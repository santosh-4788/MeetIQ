package com.oneinsure.connect

import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Once per app start: reads https://www.oneinsure.com/meet/app/android.json (published with the APK on our own server)
 * and offers the download when a newer version exists. No store, no third-party service. Silent on any error.
 */
object UpdateChecker {
    fun check(activity: MainActivity) {
        thread(name = "oic-update", isDaemon = true) {
            try {
                val url = URL(BuildConfig.PORTAL_URL.trimEnd('/') + "/app/android.json")
                val c = (url.openConnection() as HttpURLConnection).apply {
                    connectTimeout = 8000
                    readTimeout = 8000
                    instanceFollowRedirects = false
                }
                val body = c.inputStream.bufferedReader().use { it.readText() }
                if (c.responseCode != 200 || body.length > 4096) return@thread
                val info = parse(body) ?: return@thread
                if (info.versionCode > BuildConfig.VERSION_CODE) activity.runOnUiThread { activity.showUpdate(info.versionName, info.url) }
            } catch (e: Exception) {
                Log.i("OicUpdate", "no update information: ${e.javaClass.simpleName}")
            }
        }
    }

    data class Info(val versionCode: Int, val versionName: String, val url: String)

    /** Accepts only a download link on our own portal. */
    fun parse(json: String): Info? = try {
        val o = JSONObject(json)
        val url = o.getString("url")
        if (UrlPolicy.classify(url, BuildConfig.PORTAL_HOST, BuildConfig.PORTAL_PATH) != UrlPolicy.Action.INSIDE) null
        else Info(o.getInt("versionCode"), o.getString("versionName").take(20), url)
    } catch (_: Exception) {
        null
    }
}
