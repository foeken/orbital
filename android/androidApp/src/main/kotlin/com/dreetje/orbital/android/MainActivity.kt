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
// shots and the instrumented tests; history, zoom, settings, add, menu, menudemo and demoMode as the iPhone's arguments.
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
        // the launch extras (design shots, the device tests, adb) only on a debug build: another app gets a release as it is
        val start = if (savedInstanceState == null && tooling(this)) Start(intent.getStringExtra("zoom"), intent.getBooleanExtra("settings", false), intent.getBooleanExtra("add", false), intent.getBooleanExtra("menudemo", false), intent.getBooleanExtra("menu", false)) else Start()
        link(if (savedInstanceState == null) intent else null)
        setContent { OrbitalApp(engine, start) }
    }

    // brought forward by ShareActivity (what it left is taken in onResume, which follows), or by an orbital: link
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        link(intent)
    }

    // An orbital: link, the iPhone's: a widget's tap, a launcher shortcut (res/xml/shortcuts.xml) or the Quick Settings tile
    // (QuickAddTile), all through Orbital's own way in (FromOrbital), whose link waits in the app's memory; or Assistant or
    // any other app, in this exported screen's intent, whose writes the Shell turns into asking (ui/Shell.kt Link.parse). A
    // write waits for Tana on a cold start.
    private fun link(intent: Intent?) {
        val own = FromOrbital.take()
        val link = own ?: intent?.dataString?.takeIf { intent.data?.scheme == "orbital" } ?: return
        holder.engine.link = Engine.Opened(link, own != null)
    }

    companion object {
        // the launch extras (sample, demoMode, zoom, …): a debug build's, for design shots, the device tests and adb (README.md)
        fun tooling(context: android.content.Context) = context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0
    }

    override fun onResume() {
        super.onResume()
        shake.on()
        // shared to Orbital, should it have been left meanwhile (Shell.swift's scene .active: Shared.take())
        holder.viewModelScope.launch { Handoff.take(applicationContext)?.let { holder.engine.shared = it } }
        holder.viewModelScope.launch { holder.engine.foreground() } // back in front: the Timeline read again, on a live stream
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
        private val own = tooling(activity) // the sample and demo mode only on a debug build
        private val sample = own && activity.intent.getBooleanExtra("sample", false)
        val platform = AndroidPlatform(activity.applicationContext)
        val web = if (sample) null else EngineWeb(activity.applicationContext, activity.assets.open("engine.js").bufferedReader().use { it.readText() }, screen = activity)
        val engine = Engine(
            host = web, platform = platform.also { it.web = web }, scope = viewModelScope,
            sample = if (sample) activity.assets.let { a -> a.open("timeline-sample.json").bufferedReader().use { it.readText() } to a.open("pages-sample.json").bufferedReader().use { it.readText() } } else null,
            history = own && activity.intent.getBooleanExtra("history", false),
            demoMode = if (own && activity.intent.hasExtra("demoMode")) activity.intent.getBooleanExtra("demoMode", false) else null,
        )

        init {
            engine.start()
        }

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

// Orbital's own way in (AndroidManifest.xml): not exported, so Android starts it for Orbital alone: its widgets' and its
// tile's pending intents and its launcher shortcuts. It leaves their link in the app's memory, where no other app can put
// one, and brings MainActivity forward, which takes it as Orbital's own: its writes are made at once. No screen of its own.
class FromOrbital : android.app.Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pending = intent.dataString?.takeIf { intent.data?.scheme == "orbital" }
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }

    companion object {
        private var pending: String? = null // on the main thread only
        fun take(): String? = pending.also { pending = null }
        fun open(context: android.content.Context, link: String): Intent = Intent(context, FromOrbital::class.java).setData(android.net.Uri.parse(link))
    }
}
