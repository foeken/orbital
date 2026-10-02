package com.dreetje.orbital.android

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.HapticFeedbackConstants
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.content.IntentCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.dreetje.orbital.Engine
import com.dreetje.orbital.ui.OrbitalApp
import com.dreetje.orbital.ui.Start
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch

// The one screen: the shared app over an Engine kept across rotations (Holder), the engine's web view in it. Launched
// with sample=true it runs on the iPhone's invented content and never touches Tana (the iPhone's -sample), for design
// shots and the instrumented tests; history, zoom, settings, add, menudemo and demoMode as the iPhone's arguments.
class MainActivity : ComponentActivity() {
    private val holder: Holder by viewModels { Holder.Factory(this) }
    private lateinit var shake: Shake
    private var asking: CompletableDeferred<Boolean>? = null
    private val microphone = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> asking?.complete(granted); asking = null }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val engine = holder.engine
        holder.platform.askMicrophone = { CompletableDeferred<Boolean>().also { asking = it; microphone.launch(android.Manifest.permission.RECORD_AUDIO) }.await() }
        holder.platform.activity = this
        // a shake shows what is sensitive, and the next one hides it again
        shake = Shake(this) {
            engine.reveal = !engine.reveal
            window.decorView.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
        }
        val start = if (savedInstanceState == null) Start(intent.getStringExtra("zoom"), intent.getBooleanExtra("settings", false), intent.getBooleanExtra("add", false), intent.getBooleanExtra("menudemo", false)) else Start()
        setContent { OrbitalApp(engine, start) }
        if (savedInstanceState == null) take(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        take(intent)
    }

    override fun onResume() {
        super.onResume()
        shake.on()
        holder.viewModelScope.launch { holder.engine.refresh() } // back in front: the Timeline read again
    }

    override fun onPause() {
        shake.off()
        super.onPause()
    }

    override fun onDestroy() {
        if (holder.platform.activity === this) holder.platform.activity = null
        super.onDestroy()
    }

    // shared to Orbital (ACTION_SEND): its words, or its image made a JPEG of 2048 px at most, for Quick Add
    private fun take(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.takeIf { it.isNotBlank() }
        val uri = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
        holder.viewModelScope.launch {
            val image = uri?.let { Images.jpeg(contentResolver, it) }
            if (text != null || image != null) holder.engine.shared = Engine.Shared(text, image)
        }
    }

    // What lives as long as the screen does, rotations included: the platform, the engine's web view and the Engine
    class Holder(activity: MainActivity) : ViewModel() {
        private val sample = activity.intent.getBooleanExtra("sample", false)
        val platform = AndroidPlatform(activity.applicationContext)
        private val web = if (sample) null else EngineWeb(activity.applicationContext, activity.assets.open("engine.js").bufferedReader().use { it.readText() })
        val engine = Engine(
            host = web, platform = platform.also { it.web = web }, scope = viewModelScope,
            sample = if (sample) activity.assets.let { a -> a.open("timeline-sample.json").bufferedReader().use { it.readText() } to a.open("pages-sample.json").bufferedReader().use { it.readText() } } else null,
            history = activity.intent.getBooleanExtra("history", false),
            demoMode = if (activity.intent.hasExtra("demoMode")) activity.intent.getBooleanExtra("demoMode", false) else null,
        )

        init { engine.start() }

        override fun onCleared() { web?.destroy() }

        class Factory(private val activity: MainActivity) : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = Holder(activity) as T
        }
    }
}
