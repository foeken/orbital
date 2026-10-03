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
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewFeature
import com.dreetje.orbital.ChatGPT
import com.dreetje.orbital.Platform
import com.dreetje.orbital.Recorder
import com.dreetje.orbital.Store
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

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

    override fun share(text: String) {
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
        (activity ?: context).startActivity(Intent.createChooser(send, null).addFlags(if (activity == null) Intent.FLAG_ACTIVITY_NEW_TASK else 0))
    }

    override fun open(url: String) {
        runCatching { (activity ?: context).startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(if (activity == null) Intent.FLAG_ACTIVITY_NEW_TASK else 0)) }
    }

    private val clipboard get() = context.getSystemService(ClipboardManager::class.java)

    override fun hasClipboardImage(): Boolean = clipboard?.primaryClipDescription?.hasMimeType("image/*") == true

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
private class Files(context: Context) : Store {
    private val dir = File(context.filesDir, "store").apply { mkdirs() }
    override fun get(key: String): String? = File(dir, key).takeIf { it.exists() }?.let { runCatching { it.readText() }.getOrNull() }
    override fun set(key: String, value: String?) {
        if (value == null) { File(dir, key).delete(); return }
        val next = File(dir, "$key.next")
        next.writeText(value)
        if (!next.renameTo(File(dir, key))) next.delete()
    }
}
