package com.dreetje.orbital.android

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.net.Uri
import android.animation.ValueAnimator
import android.view.ViewGroup
import android.view.textclassifier.TextClassificationManager
import android.view.textclassifier.TextLanguage
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.widget.FrameLayout
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewFeature
import com.dreetje.orbital.ChatGPT
import com.dreetje.orbital.Glimpse
import com.dreetje.orbital.Platform
import com.dreetje.orbital.Recorder
import com.dreetje.orbital.Store
import com.dreetje.orbital.shortcuts
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

// What only Android can do, for the shared screens (com.dreetje.orbital.Platform)
class AndroidPlatform(private val context: Context) : Platform {
    var web: EngineWeb? = null
    var activity: Activity? = null // the screen showing now, for what has to be asked of it (the microphone, sharing)
    var askMicrophone: (() -> Unit)? = null // the screen's: puts Android's microphone question (MainActivity)
    private var asking: CompletableDeferred<Boolean>? = null // that question, open: kept here, so a new screen's answer reaches it
    private val scope = MainScope() // as long as the platform is: the screens' Holder

    override val store: Store = Prefs(context)
    // the translations once kept in store, moved to their file the first time
    override val files: Store = Files(context).also { files -> store.get("translations")?.let { files.set("translations", it); store.set("translations", null) } }
    override val chatgpt: ChatGPT = ChatGPTClient(Secrets(context))
    override val version: String = runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: ""
    override val recorder: Recorder = MicRecorder(context)
    // the system's animators off (Remove animations, a duration scale of 0, Battery Saver), as docs/ANDROID.md has it
    override val reduceMotion: Boolean get() = !ValueAnimator.areAnimatorsEnabled()

    override suspend fun microphone(): Boolean {
        if (ContextCompat.checkSelfPermission(context, android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) return true
        val answer = asking ?: CompletableDeferred<Boolean>().also { d ->
            val ask = askMicrophone ?: return false
            asking = d
            ask()
        }
        return answer.await()
    }

    // what Android's question was answered (MainActivity's launcher, the screen that asked or the one after it)
    fun microphoneAnswered(granted: Boolean) {
        asking?.complete(granted)
        asking = null
    }

    fun close() = scope.cancel()

    // Android's own language detection (renderer/translate.js asks the Mac's, the iPhone NaturalLanguage): off the main thread
    override suspend fun language(text: String): Pair<String, Float>? = withContext(Dispatchers.Default) {
        runCatching {
            val classifier = context.getSystemService(TextClassificationManager::class.java)?.textClassifier ?: return@runCatching null
            val found = classifier.detectLanguage(TextLanguage.Request.Builder(text).build())
            if (found.localeHypothesisCount == 0) null else found.getLocale(0).let { it.language to found.getConfidenceScore(it) }
        }.getOrNull()
    }

    override fun decode(image: ByteArray): ImageBitmap? = BitmapFactory.decodeByteArray(image, 0, image.size)?.asImageBitmap()

    // A picture in an outline, fetched as sdk/assets.js fetchImage does: by-uri with the bearer token answers 302 to
    // the image on Tana's CDN and the cookie the CDN wants; a 401 asks for a fresh token once
    // ponytail: no 64 MB guard as the SDK's while reading; add one if a picture that big ever turns up
    override suspend fun image(uri: String, token: suspend (refresh: Boolean) -> String): ByteArray? {
        if (!Regex("tana:image:[0-9a-z]{26}").matches(uri)) return null
        val at = URL("https://home.tana.inc/api/general/images/by-uri/" + URLEncoder.encode(uri, "UTF-8"))
        suspend fun locate(refresh: Boolean): HttpURLConnection {
            val bearer = token(refresh)
            return withContext(Dispatchers.IO) {
                (at.openConnection() as HttpURLConnection).apply {
                    instanceFollowRedirects = false; connectTimeout = 15_000; readTimeout = 30_000
                    setRequestProperty("Authorization", "Bearer " + bearer)
                    responseCode
                }
            }
        }
        var found = locate(false)
        if (found.responseCode == 401) { found.disconnect(); found = locate(true) }
        try {
            if (found.responseCode != 302) return null
            val location = found.getHeaderField("Location") ?: return null
            val cookie = found.headerFields.filterKeys { it.equals("Set-Cookie", ignoreCase = true) }.values.flatten().joinToString("; ") { it.substringBefore(';') }
            return withContext(Dispatchers.IO) {
                val c = (URL(at, location).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15_000; readTimeout = 30_000
                    if (cookie.isNotEmpty()) setRequestProperty("Cookie", cookie)
                }
                try { if (c.responseCode in 200..299) c.inputStream.use { it.readBytes() } else null } finally { c.disconnect() }
            }
        } finally {
            found.disconnect()
        }
    }

    override fun share(text: String) {
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
        (activity ?: context).startActivity(Intent.createChooser(send, null).addFlags(if (activity == null) Intent.FLAG_ACTIVITY_NEW_TASK else 0))
    }

    override fun open(url: String) {
        runCatching { (activity ?: context).startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(if (activity == null) Intent.FLAG_ACTIVITY_NEW_TASK else 0)) }
    }

    private val clipboard get() = context.getSystemService(ClipboardManager::class.java)
    override fun copy(text: String) { clipboard?.setPrimaryClip(android.content.ClipData.newPlainText("Orbital", text)) }

    override fun hasClipboardImage(): Boolean = clipboard?.primaryClipDescription?.hasMimeType("image/*") == true
    override suspend fun keepGlimpse(read: Glimpse?) = Widgets.keep(context, read) // the widgets' Timeline (Engine.keepTimeline)

    // The launcher's shortcuts for your tasks (the iPhone's Siri tasks, Intents.swift; Engine.keepTasks): the newest still
    // to do, beside Quick Add and Today's Tasks (res/xml/shortcuts.xml), each opened, checked off and pinned or unpinned
    // through Orbital's own way in (FromOrbital, Glimpse.kt shortcuts); all of them gone once forgotten. A launcher that
    // refuses (too many updates) keeps the last ones.
    override suspend fun keepTasks(tasks: List<com.dreetje.orbital.Row>?, pinned: Set<String>) {
        runCatching {
            if (tasks == null) return ShortcutManagerCompat.removeAllDynamicShortcuts(context)
            val room = (ShortcutManagerCompat.getMaxShortcutCountPerActivity(context) - 2).coerceAtLeast(0)
            ShortcutManagerCompat.setDynamicShortcuts(context, tasks.shortcuts(room, pinned).mapIndexed { i, s ->
                ShortcutInfoCompat.Builder(context, s.id).setShortLabel(s.label.take(25)).setLongLabel(s.label.take(80)).setRank(i)
                    .setIcon(IconCompat.createWithResource(context, R.mipmap.ic_launcher))
                    .setIntent(FromOrbital.open(context, s.link).setAction(Intent.ACTION_VIEW)).build()
            })
        }
    }

    // the clip read where the tap was (Android lets the app in front read it), the image made smaller off the main thread
    override suspend fun pasteImage(): ByteArray? {
        val uri = clipboard?.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.uri ?: return null
        return Images.jpeg(context.contentResolver, uri)
    }

    @Composable
    override fun rememberPhotoPicker(picked: (ByteArray) -> Unit): () -> Unit {
        val scope = rememberCoroutineScope()
        val launcher = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
            if (uri != null) scope.launch { Images.jpeg(context.contentResolver, uri)?.let(picked) }
        }
        return remember(launcher) { { launcher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) } }
    }

    // The engine's view, in a frame of the screen's own: the page EngineWeb has now (state: a new one, should Android
    // have ended the last), taken from wherever it was (the screen before)
    @Composable
    override fun EngineView(modifier: Modifier) {
        val engine = web ?: return
        AndroidView({ FrameLayout(it) }, modifier, onRelease = { it.removeAllViews() }, update = { frame ->
            val view = engine.web
            if (view.parent !== frame) {
                (view.parent as? ViewGroup)?.removeView(view)
                frame.removeAllViews()
                frame.addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            }
        })
    }

    // Sign in with ChatGPT as Codex does it (ChatGPTClient): OpenAI's page in a web view of its own, which catches the
    // answer sent to Codex's local callback before it loads, as the iPhone's does. Its cookies are its own (a WebView
    // profile, the iPhone's .nonPersistent() store) and are emptied once it closes: OpenAI's session is not needed once
    // the tokens are here, and Log out of ChatGPT then really asks again.
    @SuppressLint("SetJavaScriptEnabled")
    @Composable
    override fun ChatGPTSignIn(done: () -> Unit, failed: (String) -> Unit) {
        val client = chatgpt as ChatGPTClient
        val scope = rememberCoroutineScope()
        val verifier = remember { ChatGPTClient.random() }
        val state = remember { ChatGPTClient.random() }
        AndroidView({ ctx ->
            EngineWeb.browser(ctx, OPENAI_PROFILE).apply {
                var caught = false
                fun answer(url: Uri): Boolean {
                    if (!url.toString().startsWith(ChatGPTClient.REDIRECT)) return false
                    if (caught) return true
                    caught = true
                    stopLoading()
                    val code = url.getQueryParameter("code")
                    if (url.getQueryParameter("state") != state || code == null) {
                        caught = false
                        failed(url.getQueryParameter("error_description") ?: url.getQueryParameter("error") ?: "The sign-in did not come back from ChatGPT. Try again.")
                        return true
                    }
                    scope.launch {
                        try { client.save(client.exchange(code, verifier)); done() } catch (e: CancellationException) { throw e } catch (e: Exception) { caught = false; failed("ChatGPT did not accept the sign-in. Try again.") }
                    }
                    return true
                }
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = answer(request.url)
                    override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) { url?.let { answer(Uri.parse(it)) } }
                }
                loadUrl(ChatGPTClient.authorize(verifier, state))
            }
        }, Modifier.fillMaxSize(), onRelease = { web ->
            web.stopLoading()
            web.destroy()
            forgetOpenAI()
        })
    }

    // OpenAI's sign-in left nothing behind: its profile emptied, or, on a WebView without profiles, its sites' cookies
    // expired from the jar it shares with Tana's page
    private fun forgetOpenAI() {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            ProfileStore.getInstance().getOrCreateProfile(OPENAI_PROFILE).let { it.cookieManager.removeAllCookies(null); it.webStorage.deleteAllData() }
        } else scope.launch {
            Cookies.expire(CookieManager.getInstance(), listOf("https://auth.openai.com", "https://chatgpt.com", "https://openai.com"))
            CookieManager.getInstance().flush()
        }
    }

    private companion object {
        const val OPENAI_PROFILE = "chatgpt-sign-in"
    }
}

// SharedPreferences as the shared module's Store: what the app keeps on this phone
private class Prefs(context: Context) : Store {
    private val prefs = context.getSharedPreferences("orbital", Context.MODE_PRIVATE)
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun set(key: String, value: String?) = prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
}

// Files as the shared module's Platform.files: a file a key, written whole beside it first and moved over it, so a value
// is never half written. SharedPreferences rewrites and reads every key at once, where the translations grow for ever.
// Every write goes to one thread of its own, in the order asked (the saved Timeline, the widgets' copy, what is on its way
// to Tana, the translations), so the screen never waits on the disk; until it is there the value is kept in memory, so a
// read right after a write has it, and a write a newer one has already replaced is skipped.
internal class Files(private val dir: File) : Store {
    constructor(context: Context) : this(File(context.filesDir, "store"))
    init { dir.mkdirs() }

    override fun get(key: String): String? {
        val file = File(dir, key)
        synchronized(waiting) { if (file.path in waiting) return waiting[file.path] }
        return file.takeIf { it.exists() }?.let { runCatching { it.readText() }.getOrNull() }
    }

    override fun set(key: String, value: String?) {
        val file = File(dir, key)
        synchronized(waiting) { waiting[file.path] = value }
        writer.execute {
            if (synchronized(waiting) { waiting[file.path] !== value }) return@execute // replaced since: the newer one writes
            runCatching {
                if (value == null) file.delete() else File(dir, "$key.next").let { next -> next.writeText(value); if (!next.renameTo(file)) next.delete() }
            }
            synchronized(waiting) { if (waiting[file.path] === value) waiting.remove(file.path) }
        }
    }

    companion object {
        private val waiting = HashMap<String, String?>() // file -> the value on its way to it
        internal val writer: java.util.concurrent.ExecutorService = java.util.concurrent.Executors.newSingleThreadExecutor { Thread(it, "orbital-files").apply { isDaemon = true } }
        internal fun flush() { writer.submit {}.get() } // every write asked so far on disk (tests)
    }
}
