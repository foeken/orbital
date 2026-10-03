package com.dreetje.orbital.android

import android.annotation.SuppressLint
import android.content.Context
import android.content.MutableContextWrapper
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.net.Uri
import android.os.SystemClock
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.dreetje.orbital.Bridge
import com.dreetje.orbital.EngineHost
import com.dreetje.orbital.Failure
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlin.coroutines.resume
import kotlin.time.Duration.Companion.minutes

// The engine's web view (ios/Orbital/Engine.swift, for Android): https://home.tana.inc/api/auth/session with engine.js
// injected once it has loaded, so the SDK runs same-origin on Tana's own cookies. engine.js speaks to the iPhone's
// message handler; Bridge.SHIM points that at a web message listener this view only answers on Tana's origin, and
// each call's answer comes back through it with the call's number. Signed out, the same view shows Tana's sign-in.
// Android may end the page's renderer to free memory, which WebKit never does to the iPhone's: then a new view takes
// its place (web is state, so the screen shows the new one) and the engine starts again on it.
@SuppressLint("SetJavaScriptEnabled")
class EngineWeb(private val app: Context, private val engine: String, screen: Context? = null) : EngineHost {
    // the screen showing now while there is one (use): Tana's and Google's sign-in open dialogs, autofill and the
    // selection bar, which need a window an application context does not have; the app's own between screens
    private val context = MutableContextWrapper(screen ?: app)
    override var listener: EngineHost.Listener? = null
    private val pending = mutableMapOf<Int, CompletableDeferred<JsonElement>>() // on the main thread only
    private var next = 0
    private var injected = false // onPageFinished can come twice for one load: the engine runs once a page
    private var restartedAt = 0L // when the last page was replaced, so one that keeps being ended is said, not retried

    var web by mutableStateOf(make())
        private set

    init {
        // Chrome's inspector on a debug build only, where the page holds a live Tana token
        WebView.setWebContentsDebuggingEnabled(app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        CookieManager.getInstance().setAcceptCookie(true)
    }

    fun use(screen: Context?) { context.baseContext = screen ?: app }

    private fun make(): WebView = WebView(context).also { web ->
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true // the settings mirror and the device's storage id (ios/engine/stand-ins.js)
        web.settings.userAgentString = chrome(web.settings.userAgentString)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true) // Tana's sign-in hands over through WorkOS
        // no X-Requested-With: Google refuses to sign in a page that says it is an app's web view
        if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) WebSettingsCompat.setRequestedWithHeaderOriginAllowList(web.settings, emptySet())
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, Bridge.LISTENER, setOf(Bridge.ORIGIN)) { view, message, origin, mainFrame, _ ->
                // the rule above already keeps it to Tana's origin; the page itself, the view on screen and that origin
                // again, as docs/ANDROID.md has it
                if (view === this.web && Bridge.trusted(origin.toString(), mainFrame)) message.data?.let(::receive)
            }
        }
        web.webViewClient = Client()
    }

    private inner class Client : WebViewClient() {
        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            injected = false
            fail("The page moved on") // a call into the page that was there is never answered now: said so
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

        // The renderer ended under the page (Android freeing memory, or a crash): unhandled, Android ends the app with
        // it. A new view instead, and the engine started again on it; a page ended again within the minute, or one that
        // crashed, is said, and Try again starts it.
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view !== web) return true // an earlier view's, already replaced
            fail("Tana's page stopped")
            (view.parent as? ViewGroup)?.removeView(view)
            view.destroy()
            injected = false
            web = make()
            val now = SystemClock.elapsedRealtime()
            val retry = !detail.didCrash() && now - restartedAt > 60_000
            restartedAt = now
            if (retry) listener?.restarted("Android stopped Tana's page to free memory: starting it again")
            else listener?.failed(if (detail.didCrash()) "Tana's page crashed. Try again." else "Android keeps stopping Tana's page to free memory. Try again.")
            return true
        }
    }

    private fun fail(why: String) {
        pending.values.forEach { it.completeExceptionally(Failure(why)) }
        pending.clear()
    }

    private fun receive(data: String) {
        when (val heard = Bridge.read(data)) {
            is Bridge.Heard.Said -> listener?.said(heard.message) // 'ready', 'changed'
            is Bridge.Heard.Answer -> {
                val call = pending.remove(heard.id) ?: return
                val error = heard.error
                if (error == null) call.complete(heard.value ?: JsonNull) else call.completeExceptionally(Failure(error))
            }
            null -> {}
        }
    }

    // A call that is never answered (a page replaced under it without a load, a script that never settles) gives up,
    // as callAsyncJavaScript fails on the iPhone, rather than holding what waits on it for ever. Two minutes: the first
    // read of a large Timeline on a slow network takes tens of seconds.
    override suspend fun run(body: String, args: Map<String, Any?>): JsonElement = withContext(Dispatchers.Main.immediate) {
        val id = next++
        val answer = CompletableDeferred<JsonElement>()
        pending[id] = answer
        web.evaluateJavascript(Bridge.script(id, body, args), null)
        try {
            withTimeoutOrNull(2.minutes) { answer.await() } ?: throw Failure("Tana's page did not answer")
        } finally {
            pending.remove(id)
        }
    }

    override fun load(url: String) = web.loadUrl(url)

    override val url: String? get() = web.url

    override fun cookieNames(): List<String> = Cookies.names(CookieManager.getInstance(), TANA)

    // Log out: Tana's cookies go, as the iPhone's deletes those of *.tana.inc only (Engine.swift signOut), so Google's
    // and WorkOS's sign-ins stay. Should one of Tana's outlast that (set for a path of its own), every cookie goes
    // rather than a session staying behind.
    override suspend fun forgetCookies() {
        val cookies = CookieManager.getInstance()
        Cookies.expire(cookies, TANA)
        if (Cookies.names(cookies, TANA).isNotEmpty()) suspendCancellableCoroutine { done -> cookies.removeAllCookies { done.resume(Unit) } }
        cookies.flush()
    }

    override fun keepCookies() = CookieManager.getInstance().flush()

    fun destroy() {
        fail("The app closed")
        (web.parent as? ViewGroup)?.removeView(web)
        web.destroy()
    }

    companion object {
        private val TANA = listOf("https://home.tana.inc", "https://tana.inc")

        // Google and others refuse sign-in in a page that says it is a web view: Chrome's own words, without "; wv"
        fun chrome(agent: String) = agent.replace("; wv", "").replace(Regex("Version/[\\d.]+ "), "")
    }
}

// A site's cookies, which CookieManager neither lists nor deletes one by one: by name from what the site is sent, and
// each written again already expired, host-only and for every domain above the host, so whichever it was set as goes
object Cookies {
    fun names(manager: CookieManager, sites: List<String>): List<String> = sites.flatMap { site ->
        manager.getCookie(site)?.split(";")?.map { it.substringBefore("=").trim() }?.filter { it.isNotEmpty() }.orEmpty()
    }.distinct()

    suspend fun expire(manager: CookieManager, sites: List<String>) {
        for (site in sites) {
            val host = Uri.parse(site).host ?: continue
            val domains = listOf<String?>(null) + generateSequence(host) { h -> h.substringAfter('.', "").takeIf { '.' in it } }
            for (name in names(manager, listOf(site))) for (domain in domains) {
                val gone = "$name=; Max-Age=0; Path=/; Secure" + (domain?.let { "; Domain=$it" } ?: "")
                suspendCancellableCoroutine { done -> manager.setCookie(site, gone) { done.resume(Unit) } }
            }
        }
    }
}
