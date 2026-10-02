package com.dreetje.orbital.android

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.Settings
import android.view.textclassifier.TextClassificationManager
import android.view.textclassifier.TextLanguage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
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
import com.dreetje.orbital.AI
import com.dreetje.orbital.Platform
import com.dreetje.orbital.Recorder
import com.dreetje.orbital.Store
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// What only Android can do, for the shared screens (com.dreetje.orbital.Platform)
class AndroidPlatform(private val context: Context) : Platform {
    var web: EngineWeb? = null
    var activity: Activity? = null // the screen showing now, for what has to be asked of it (the microphone, sharing)
    var askMicrophone: (suspend () -> Boolean)? = null

    override val store: Store = Prefs(context)
    override val ai: AI = ChatGPTClient(Secrets(context))
    override val version: String = runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: ""
    override val recorder: Recorder = MicRecorder(context)
    override val reduceMotion: Boolean get() = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

    override suspend fun microphone(): Boolean {
        if (ContextCompat.checkSelfPermission(context, android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) return true
        return askMicrophone?.invoke() ?: false
    }

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

    override fun clipboardImage(): ByteArray? {
        val uri = clipboard?.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.uri ?: return null
        return runCatching { Images.jpegNow(context.contentResolver, uri) }.getOrNull()
    }

    @Composable
    override fun rememberPhotoPicker(picked: (ByteArray) -> Unit): () -> Unit {
        val scope = rememberCoroutineScope()
        val launcher = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
            if (uri != null) scope.launch { Images.jpeg(context.contentResolver, uri)?.let(picked) }
        }
        return remember(launcher) { { launcher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) } }
    }

    @Composable
    override fun EngineView(modifier: Modifier) {
        val web = web ?: return
        AndroidView({ web.attach() }, modifier)
    }

    // Sign in with ChatGPT as Codex does it (ChatGPTClient): OpenAI's page in a web view of its own, which catches the
    // answer sent to Codex's local callback before it loads, as the iPhone's does
    @SuppressLint("SetJavaScriptEnabled")
    @Composable
    override fun ChatGPTSignIn(done: () -> Unit, failed: (String) -> Unit) {
        val client = ai as ChatGPTClient
        val scope = rememberCoroutineScope()
        val verifier = remember { ChatGPTClient.random() }
        val state = remember { ChatGPTClient.random() }
        AndroidView({ ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.userAgentString = EngineWeb.chrome(settings.userAgentString)
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
        }, Modifier.fillMaxSize())
    }
}

// SharedPreferences as the shared module's Store: what the app keeps on this phone
private class Prefs(context: Context) : Store {
    private val prefs = context.getSharedPreferences("orbital", Context.MODE_PRIVATE)
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun set(key: String, value: String?) = prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
}
