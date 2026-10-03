package com.dreetje.orbital.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.core.content.IntentCompat
import androidx.lifecycle.lifecycleScope
import com.dreetje.orbital.Engine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

// Share to Orbital (ios/Share/ShareViewController.swift): what was shared is left where the app finds it (Handoff), and
// Orbital brought forward in its own task on Quick Add: an image to be read at once, anything else as words to edit
// there. No screen of its own. Android starts a share's target in the sharing app's task, so MainActivity taking it
// there was a second Orbital, its own Tana page and engine, inside the other app.
class ShareActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        lifecycleScope.launch {
            if (share(intent)) {
                startActivity(Intent(this@ShareActivity, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            } else {
                // kept nothing: said here, rather than Orbital opening on an empty Quick Add
                Toast.makeText(applicationContext, "Orbital could not take what was shared", Toast.LENGTH_SHORT).show()
            }
            finish()
        }
    }

    // the image, made a JPEG of 2048 px at most (what Quick Add reads it at anyway); else the words, each once
    private suspend fun share(intent: Intent): Boolean {
        if (intent.action != Intent.ACTION_SEND) return false
        val image = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { Images.jpeg(contentResolver, it) }
        val words = Engine.Shared.words(intent.getStringExtra(Intent.EXTRA_SUBJECT), intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
        if (image == null && words == null) return false
        return withContext(Dispatchers.IO) { Handoff.leave(applicationContext, words, image) }
    }
}

// The handoff (QuickAdd.swift Shared, the Keychain items on the iPhone): an image or words in the app's own cache,
// taken once, when Orbital is next in front
object Handoff {
    private fun dir(context: Context) = File(context.cacheDir, "shared")

    @Synchronized
    fun leave(context: Context, text: String?, jpeg: ByteArray?): Boolean = runCatching {
        val dir = dir(context).apply { deleteRecursively(); mkdirs() }
        if (jpeg != null) File(dir, "image.jpg").writeBytes(jpeg) else File(dir, "text.txt").writeText(text ?: "")
        true
    }.getOrDefault(false)

    suspend fun take(context: Context): Engine.Shared? = withContext(Dispatchers.IO) { takeNow(context) }

    @Synchronized // onNewIntent's resume and the next one: taken once
    private fun takeNow(context: Context): Engine.Shared? {
        val dir = dir(context)
        if (!dir.exists()) return null
        val image = runCatching { File(dir, "image.jpg").takeIf { it.exists() }?.readBytes() }.getOrNull()
        val text = runCatching { File(dir, "text.txt").takeIf { it.exists() }?.readText() }.getOrNull()
        dir.deleteRecursively()
        return if (image != null || !text.isNullOrBlank()) Engine.Shared(text, image) else null
    }
}
