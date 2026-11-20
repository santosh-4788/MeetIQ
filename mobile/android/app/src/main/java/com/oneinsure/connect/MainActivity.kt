package com.oneinsure.connect

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.util.Base64
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * OneInsure Connect for Android: the portal (https://www.oneinsure.com/meet) in a locked-down WebView, plus what a phone
 * browser cannot do - presenting the phone screen ([ScreenShareSession]) and keeping the call alive in the background
 * ([MeetingService]).
 *
 * The page talks to the app through `window.OicAndroid` (androidx.webkit WebMessageListener): it exists ONLY on pages
 * from https://www.oneinsure.com, only in the main frame. Messages (JSON):
 *   {type:"info"}                                   -> reply {type:"info", app:"android", versionName, versionCode, presenting}
 *   {type:"present", url, token, name}              -> asks Android's "Start recording or casting?" then presents
 *   {type:"stopPresent"}
 *   {type:"inMeeting", on}                          -> keeps the microphone alive in the background, screen on
 *   {type:"saveFile", name, mime, base64}           -> saves a page-generated file (e.g. a report) to Downloads
 * Events to the page: {type:"present", state:"STARTING"|"PRESENTING"|"IDLE", detail}
 */
class MainActivity : AppCompatActivity() {
    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private var offline: View? = null
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null
    private var replyProxy: JavaScriptReplyProxy? = null
    private var inMeeting = false

    private var pendingPermission: PermissionRequest? = null
    private var pendingPresent: Triple<String, String, String>? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val host = BuildConfig.PORTAL_HOST
    private val path = BuildConfig.PORTAL_PATH

    private val mediaPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        val req = pendingPermission ?: return@registerForActivityResult
        pendingPermission = null
        val allowed = req.resources.filter { r ->
            when (r) {
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> granted(android.Manifest.permission.CAMERA)
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> granted(android.Manifest.permission.RECORD_AUDIO)
                else -> false
            }
        }
        if (allowed.isEmpty()) {
            req.deny()
            if (result.values.any { !it }) Toast.makeText(this, R.string.permission_denied_media, Toast.LENGTH_LONG).show()
        } else {
            req.grant(allowed.toTypedArray())
        }
        if (inMeeting) MeetingService.start(this)
    }

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { _ ->
        launchProjection()
    }

    private val projection = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        val p = pendingPresent
        pendingPresent = null
        if (p == null) return@registerForActivityResult
        val data = res.data
        if (res.resultCode != Activity.RESULT_OK || data == null) {
            sendPresentState(ScreenShareSession.State.IDLE, "cancelled")
            return@registerForActivityResult
        }
        ScreenShareSession.start(this, p.first, p.second, p.third, data)
    }

    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        val cb = fileCallback ?: return@registerForActivityResult
        fileCallback = null
        cb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res.resultCode, res.data))
    }

    private val legacyStorage = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        val f = pendingSave
        pendingSave = null
        if (ok && f != null) save(f.first, f.second, f.third)
        else if (f != null) Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show()
    }
    private var pendingSave: Triple<String, String, ByteArray>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        root = FrameLayout(this)
        web = WebView(this)
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            setGeolocationEnabled(false)
            userAgentString = "$userAgentString OneInsureConnectApp/${BuildConfig.VERSION_NAME}"
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING_ENABLE)) WebSettingsCompat.setSafeBrowsingEnabled(web.settings, true)
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)

        installBridge()
        web.webViewClient = Client()
        web.webChromeClient = Chrome()
        web.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ -> download(url, userAgent, contentDisposition, mimeType) }

        ScreenShareSession.listener = { s, detail -> runOnUiThread { sendPresentState(s, detail) } }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    customView != null -> hideCustomView()
                    web.canGoBack() -> web.goBack() // the meeting page asks "Leave the meeting?" itself
                    inMeeting -> moveTaskToBack(true) // never end a call by backing out of the app
                    else -> finish()
                }
            }
        })

        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(startUrl(intent))
        handleAction(intent)
        UpdateChecker.check(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (handleAction(intent)) return
        val link = intent.data?.toString()
        if (link != null && UrlPolicy.classify(link, host, path) == UrlPolicy.Action.INSIDE) web.loadUrl(link)
    }

    private fun handleAction(intent: Intent?): Boolean {
        if (intent?.action == ScreenShareSession.ACTION_STOP) {
            ScreenShareSession.stop("user")
            return true
        }
        return false
    }

    private fun startUrl(intent: Intent?): String {
        val link = intent?.data?.toString()
        return if (link != null && UrlPolicy.classify(link, host, path) == UrlPolicy.Action.INSIDE) link else BuildConfig.PORTAL_URL
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        if (isFinishing) {
            ScreenShareSession.listener = null
            ScreenShareSession.stop("app_closed", notify = false)
            MeetingService.stop(this)
            web.destroy()
        }
        super.onDestroy()
    }

    // ---- Bridge -----------------------------------------------------------------------------------------------------

    private fun installBridge() {
        val origin = "https://$host"
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return // old WebView: portal works, no app extras
        WebViewCompat.addWebMessageListener(web, "OicAndroid", setOf(origin)) { _, message, sourceOrigin, isMainFrame, reply ->
            if (!isMainFrame || sourceOrigin.toString().trimEnd('/') != origin) return@addWebMessageListener
            replyProxy = reply
            val msg = try { JSONObject(message.data ?: "{}") } catch (_: Exception) { return@addWebMessageListener }
            when (msg.optString("type")) {
                "info" -> reply.postMessage(JSONObject()
                    .put("type", "info").put("app", "android")
                    .put("versionName", BuildConfig.VERSION_NAME).put("versionCode", BuildConfig.VERSION_CODE)
                    .put("screenShare", true).put("presenting", ScreenShareSession.state != ScreenShareSession.State.IDLE)
                    .toString())
                "present" -> present(msg.optString("url"), msg.optString("token"), msg.optString("name"))
                "stopPresent" -> ScreenShareSession.stop("user")
                "inMeeting" -> setInMeeting(msg.optBoolean("on"))
                "saveFile" -> saveFromPage(msg.optString("name"), msg.optString("mime"), msg.optString("base64"))
            }
        }
        // Page-made files (blob: links, e.g. CSV/PDF reports): keep them readable long enough for the app to save them.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, """
                (function(){ var r = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = function(u){ setTimeout(function(){ r(u) }, 60000) }; })();
            """.trimIndent(), setOf(origin))
        }
    }

    private fun present(url: String, token: String, name: String) {
        // Only to our own video server, with a token's shape; the server decides what the token may do.
        if (!UrlPolicy.isOurVideoServer(url, host) || !UrlPolicy.looksLikeAccessToken(token)) {
            sendPresentState(ScreenShareSession.State.IDLE, "error:refused")
            return
        }
        if (ScreenShareSession.state != ScreenShareSession.State.IDLE) return
        pendingPresent = Triple(url, token, name)
        if (Build.VERSION.SDK_INT >= 33 && !granted(android.Manifest.permission.POST_NOTIFICATIONS)) {
            notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS) // then launchProjection()
        } else {
            launchProjection()
        }
    }

    private fun launchProjection() {
        if (pendingPresent == null) return
        val mpm = getSystemService(MediaProjectionManager::class.java)
        try {
            projection.launch(mpm.createScreenCaptureIntent())
        } catch (e: Exception) {
            pendingPresent = null
            sendPresentState(ScreenShareSession.State.IDLE, "error:" + (e.message ?: "unavailable"))
        }
    }

    // replyProxy only exists when WEB_MESSAGE_LISTENER is supported (installBridge checks it).
    @SuppressLint("RequiresFeature")
    private fun sendPresentState(s: ScreenShareSession.State, detail: String?) {
        val json = JSONObject().put("type", "present").put("state", s.name)
        if (detail != null) json.put("detail", detail)
        try { replyProxy?.postMessage(json.toString()) } catch (_: Exception) {}
        if (s == ScreenShareSession.State.IDLE && detail != null && detail.startsWith("error:")) {
            Toast.makeText(this, R.string.screen_share_failed, Toast.LENGTH_LONG).show()
        }
    }

    private fun setInMeeting(on: Boolean) {
        if (on == inMeeting) return
        inMeeting = on
        if (on) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            MeetingService.start(this)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            MeetingService.stop(this)
            ScreenShareSession.stop("left_meeting")
        }
    }

    // ---- WebView clients --------------------------------------------------------------------------------------------

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            return when (UrlPolicy.classify(url, host, path)) {
                UrlPolicy.Action.INSIDE -> false
                UrlPolicy.Action.OUTSIDE -> { if (request.isForMainFrame || request.hasGesture()) openOutside(url); true }
                UrlPolicy.Action.BLOCK -> !url.startsWith("blob:") // blob: downloads go to the download listener
            }
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            hideOffline()
            // A full page load is a new document: the meeting page reports "inMeeting" again if it is one.
            replyProxy = null
            if (inMeeting) setInMeeting(false)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) showOffline()
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) {
            runOnUiThread {
                val o = request.origin
                if (o.scheme != "https" || !o.host.equals(host, ignoreCase = true)) return@runOnUiThread request.deny()
                val wanted = mutableListOf<String>()
                request.resources.forEach { r ->
                    if (r == PermissionRequest.RESOURCE_VIDEO_CAPTURE) wanted += android.Manifest.permission.CAMERA
                    if (r == PermissionRequest.RESOURCE_AUDIO_CAPTURE) wanted += android.Manifest.permission.RECORD_AUDIO
                }
                if (wanted.isEmpty()) return@runOnUiThread request.deny()
                val missing = wanted.filter { !granted(it) }
                if (missing.isEmpty()) {
                    request.grant(request.resources.filter { it == PermissionRequest.RESOURCE_VIDEO_CAPTURE || it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }.toTypedArray())
                    if (inMeeting) MeetingService.start(this@MainActivity)
                } else {
                    pendingPermission?.deny()
                    pendingPermission = request
                    mediaPermissions.launch(missing.toTypedArray())
                }
            }
        }

        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            return try {
                fileChooser.launch(params.createIntent())
                true
            } catch (_: ActivityNotFoundException) {
                fileCallback = null
                false
            }
        }

        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (customView != null) return callback.onCustomViewHidden()
            customView = view
            customCallback = callback
            root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            web.visibility = View.GONE
        }

        override fun onHideCustomView() = hideCustomView()
    }

    private fun hideCustomView() {
        val v = customView ?: return
        root.removeView(v)
        customView = null
        web.visibility = View.VISIBLE
        customCallback?.onCustomViewHidden()
        customCallback = null
    }

    // ---- Outside links, downloads, offline -------------------------------------------------------------------------

    private fun openOutside(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, url, Toast.LENGTH_LONG).show()
        }
    }

    private fun download(url: String, userAgent: String, contentDisposition: String?, mimeType: String?) {
        if (url.startsWith("blob:")) {
            // A file the page made: read it in the page and hand it to the app.
            val js = """
                (function(){ fetch(${JSONObject.quote(url)}).then(function(r){ return r.blob() }).then(function(b){
                  var fr = new FileReader(); fr.onload = function(){
                    var a = document.querySelector('a[href=' + JSON.stringify(${JSONObject.quote(url)}) + ']');
                    var name = (a && a.getAttribute('download')) || 'download';
                    OicAndroid.postMessage(JSON.stringify({ type: 'saveFile', name: name, mime: b.type, base64: String(fr.result).split(',')[1] || '' }));
                  }; fr.readAsDataURL(b); }); })();
            """.trimIndent()
            web.evaluateJavascript(js, null)
            return
        }
        if (UrlPolicy.classify(url, host, path) != UrlPolicy.Action.INSIDE) return openOutside(url)
        val name = UrlPolicy.safeFileName(URLUtil.guessFileName(url, contentDisposition, mimeType))
        try {
            val req = DownloadManager.Request(Uri.parse(url))
                .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                .addRequestHeader("User-Agent", userAgent)
                .setMimeType(mimeType)
                .setTitle(name)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            getSystemService(DownloadManager::class.java).enqueue(req)
            Toast.makeText(this, getString(R.string.download_started, name), Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Log.w("OicDownload", "download failed", e)
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show()
        }
    }

    private fun saveFromPage(name: String, mime: String, base64: String) {
        val bytes = try { Base64.decode(base64, Base64.DEFAULT) } catch (_: Exception) { return }
        if (bytes.isEmpty() || bytes.size > 50 * 1024 * 1024) return
        val safe = UrlPolicy.safeFileName(name)
        val type = mime.ifBlank { "application/octet-stream" }
        if (Build.VERSION.SDK_INT < 29 && !granted(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)) {
            pendingSave = Triple(safe, type, bytes)
            legacyStorage.launch(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
            return
        }
        save(safe, type, bytes)
    }

    private fun save(name: String, mime: String, bytes: ByteArray) {
        val ok = Downloads.save(this, name, mime, bytes)
        Toast.makeText(this, if (ok) getString(R.string.download_saved, name) else getString(R.string.download_failed), Toast.LENGTH_LONG).show()
    }

    private fun showOffline() {
        if (offline != null) return
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#081525"))
            setPadding(48, 48, 48, 48)
            addView(TextView(context).apply { setText(R.string.offline_title); setTextColor(Color.WHITE); textSize = 20f; gravity = Gravity.CENTER })
            addView(TextView(context).apply { setText(R.string.offline_text); setTextColor(Color.parseColor("#B8C4D4")); textSize = 15f; gravity = Gravity.CENTER; setPadding(0, 24, 0, 32) })
            addView(Button(context).apply { setText(R.string.retry); setOnClickListener { web.reload() } })
        }
        offline = box
        root.addView(box, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    private fun hideOffline() {
        offline?.let { root.removeView(it) }
        offline = null
    }

    private fun granted(permission: String) = ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    internal fun showUpdate(versionName: String, url: String) {
        if (isFinishing || isDestroyed) return
        AlertDialog.Builder(this)
            .setTitle(R.string.update_title)
            .setMessage(getString(R.string.update_text, versionName))
            .setPositiveButton(R.string.update_now) { _, _ -> openOutside(url) }
            .setNegativeButton(R.string.later, null)
            .show()
    }
}
