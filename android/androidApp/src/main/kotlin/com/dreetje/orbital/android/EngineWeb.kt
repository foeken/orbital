package com.dreetje.orbital.android

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.dreetje.orbital.Bridge
import com.dreetje.orbital.EngineHost
import com.dreetje.orbital.Failure
import com.dreetje.orbital.json
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.coroutines.resume

// The engine's web view (ios/Orbital/Engine.swift, for Android): https://home.tana.inc/api/auth/session with engine.js
// injected once it has loaded, so the SDK runs same-origin on Tana's own cookies. engine.js speaks to the iPhone's
// message handler; Bridge.SHIM points that at a web message listener this view only answers on Tana's origin, and
// each call's answer comes back through it with the call's number. Signed out, the same view shows Tana's sign-in.
@SuppressLint("SetJavaScriptEnabled")
class EngineWeb(context: Context, private val engine: String) : EngineHost {
    val web = WebView(context)
    override var listener: EngineHost.Listener? = null
    private val pending = mutableMapOf<Int, CompletableDeferred<JsonElement>>() // on the main thread only
    private var next = 0
    private var injected = false // onPageFinished can come twice for one load: the engine runs once a page

    init {
        // Chrome's inspector on a debug build only, where the page holds a live Tana token
        WebView.setWebContentsDebuggingEnabled(context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true // the settings mirror and the device's storage id (ios/engine/stand-ins.js)
        web.settings.userAgentString = chrome(web.settings.userAgentString)
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true) // Tana's sign-in hands over through WorkOS
        // no X-Requested-With: Google refuses to sign in a page that says it is an app's web view
        if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) WebSettingsCompat.setRequestedWithHeaderOriginAllowList(web.settings, emptySet())
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, Bridge.LISTENER, setOf("https://home.tana.inc")) { _, message, _, isMainFrame, _ ->
                if (isMainFrame) message.data?.let(::receive)
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                injected = false
                // a call into the page that was there is never answered now: said so, rather than waited on for ever
                pending.values.forEach { it.completeExceptionally(Failure("The page moved on")) }
                pending.clear()
            }

            override fun onPageFinished(view: WebView, url: String?) {
                if (injected || url?.startsWith(com.dreetje.orbital.Engine.SESSION) != true) return
                injected = true
                if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) { listener?.failed("This phone's Android System WebView is too old for Orbital. Update it in Google Play."); return }
                view.evaluateJavascript(Bridge.SHIM + engine, null)
            }

            // A page that never started: offline, or Tana unreachable. A load cut off on purpose is not one (a redirect
            // replacing it, as sign-in hands over: net::ERR_ABORTED).
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame || error.errorCode == ERROR_UNKNOWN) return
                listener?.failed(error.description?.toString() ?: "The page did not load")
            }

            // every page stays in this view: Tana's own app claims home.tana.inc, and sign-in must land here
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = request.url.scheme !in setOf("http", "https")
        }
    }

    private fun receive(data: String) {
        if (!data.startsWith("{")) { listener?.said(data); return } // 'ready', 'changed'
        val answer = runCatching { json.parseToJsonElement(data).jsonObject }.getOrNull() ?: return
        val id = answer["id"]?.jsonPrimitive?.intOrNull ?: return
        val call = pending.remove(id) ?: return
        if (answer["ok"]?.jsonPrimitive?.booleanOrNull == true) call.complete(answer["value"] ?: JsonNull)
        else call.completeExceptionally(Failure(answer["error"]?.jsonPrimitive?.contentOrNull ?: "The engine failed"))
    }

    override suspend fun run(body: String, args: Map<String, Any?>): JsonElement = withContext(Dispatchers.Main.immediate) {
        val id = next++
        val answer = CompletableDeferred<JsonElement>()
        pending[id] = answer
        web.evaluateJavascript(Bridge.script(id, body, args), null)
        try { answer.await() } finally { pending.remove(id) }
    }

    override fun load(url: String) = web.loadUrl(url)

    override val url: String? get() = web.url

    override fun cookieNames(): List<String> =
        CookieManager.getInstance().getCookie("https://home.tana.inc")?.split(";")?.map { it.substringBefore("=").trim() }?.filter { it.isNotEmpty() } ?: emptyList()

    override suspend fun forgetCookies() {
        suspendCancellableCoroutine { done -> CookieManager.getInstance().removeAllCookies { done.resume(Unit) } }
        CookieManager.getInstance().flush()
    }

    override fun keepCookies() = CookieManager.getInstance().flush()

    // the view shown while signed out: taken from wherever it was (a rotation's old screen)
    fun attach(): WebView = web.also { (it.parent as? ViewGroup)?.removeView(it) }

    fun destroy() {
        (web.parent as? ViewGroup)?.removeView(web)
        web.destroy()
    }

    companion object {
        // Google and others refuse sign-in in a page that says it is a web view: Chrome's own words, without "; wv"
        fun chrome(agent: String) = agent.replace("; wv", "").replace(Regex("Version/[\\d.]+ "), "")
    }
}
