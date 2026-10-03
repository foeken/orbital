package com.dreetje.orbital.android

import android.content.Intent
import android.os.Bundle
import android.view.HapticFeedbackConstants
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.dreetje.orbital.Engine
import com.dreetje.orbital.ui.OrbitalApp
import com.dreetje.orbital.ui.Start
import kotlinx.coroutines.launch

// The one screen: the shared app over an Engine kept across rotations (Holder), the engine's web view in it. Launched
// with sample=true it runs on the iPhone's invented content and never touches Tana (the iPhone's -sample), for design
// shots and the instrumented tests; history, zoom, settings, add, menudemo and demoMode as the iPhone's arguments.
// A turn of the phone, a fold or a keyboard does not make it again (AndroidManifest.xml configChanges): Compose lays
// the same screen out anew, what is open and typed stays, and the web view never leaves its window.
class MainActivity : ComponentActivity() {
    private val holder: Holder by viewModels { Holder.Factory(this) }
    private lateinit var shake: Shake
    // Android's microphone question; its answer goes to the platform, where the question waits (a screen made again
    // after asking hands it this one's answer)
    private val microphone = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> holder.platform.microphoneAnswered(granted) }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val engine = holder.engine
        holder.platform.askMicrophone = { microphone.launch(android.Manifest.permission.RECORD_AUDIO) }
        holder.platform.activity = this
        holder.web?.use(this) // its dialogs and autofill in this window
        // a shake shows what is sensitive, and the next one hides it again
        shake = Shake(this) {
            engine.reveal = !engine.reveal
            window.decorView.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
        }
        val start = if (savedInstanceState == null) Start(intent.getStringExtra("zoom"), intent.getBooleanExtra("settings", false), intent.getBooleanExtra("add", false), intent.getBooleanExtra("menudemo", false)) else Start()
        setContent { OrbitalApp(engine, start) }
    }

    // brought forward by ShareActivity: what it left is taken in onResume, which follows
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        shake.on()
        // shared to Orbital, should it have been left meanwhile (Shell.swift's scene .active: Shared.take())
        holder.viewModelScope.launch { Handoff.take(applicationContext)?.let { holder.engine.shared = it } }
        holder.viewModelScope.launch { holder.engine.refresh() } // back in front: the Timeline read again
    }

    override fun onPause() {
        shake.off()
        super.onPause()
    }

    override fun onDestroy() {
        if (holder.platform.activity === this) {
            holder.platform.activity = null
            holder.platform.askMicrophone = null
            holder.web?.use(null) // no screen kept by the page that outlives it
            if (isFinishing) holder.platform.microphoneAnswered(false) // nobody left to answer it
        }
        super.onDestroy()
    }

    // What lives as long as the screen does, a remake included: the platform, the engine's web view and the Engine
    class Holder(activity: MainActivity) : ViewModel() {
        private val sample = activity.intent.getBooleanExtra("sample", false)
        val platform = AndroidPlatform(activity.applicationContext)
        val web = if (sample) null else EngineWeb(activity.applicationContext, activity.assets.open("engine.js").bufferedReader().use { it.readText() }, screen = activity)
        val engine = Engine(
            host = web, platform = platform.also { it.web = web }, scope = viewModelScope,
            sample = if (sample) activity.assets.let { a -> a.open("timeline-sample.json").bufferedReader().use { it.readText() } to a.open("pages-sample.json").bufferedReader().use { it.readText() } } else null,
            history = activity.intent.getBooleanExtra("history", false),
            demoMode = if (activity.intent.hasExtra("demoMode")) activity.intent.getBooleanExtra("demoMode", false) else null,
        )

        init { engine.start() }

        override fun onCleared() {
            web?.destroy()
            platform.close()
        }

        class Factory(private val activity: MainActivity) : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = Holder(activity) as T
        }
    }
}
