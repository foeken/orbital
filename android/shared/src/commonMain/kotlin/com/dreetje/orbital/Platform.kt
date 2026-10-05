package com.dreetje.orbital

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// The app's only link to Tana: one web view, kept on https://home.tana.inc/api/auth/session running engine.js, which is
// Orbital's own SDK and main/timeline.js bundled for the phones (ios/engine). Same-origin there, the SDK uses the web
// view's login cookies as Tana's own client does. The Android app's EngineWeb is one; tests bring a fake.
interface EngineHost {
    // what engine.js says (window.webkit.messageHandlers.orbital.postMessage): 'ready' once it is loaded on the session
    // page, 'changed' when the Timeline moved under it; and a page that never started (offline), with why
    var listener: Listener?

    interface Listener {
        fun said(message: String)
        fun failed(message: String)
        // the page was replaced by a new one (Android ended the old one's renderer to free memory): start again on it
        fun restarted(why: String) {}
    }

    // body run as an async function's in the page, args bound by name (callAsyncJavaScript on the iPhone): what it
    // returned, as JSON. Throws what the engine threw. Only on the session page (Bridge.onSessionPage), unless
    // anyTanaPage: the sign-in watch's own probe, which carries nothing and runs on Tana's sign-in pages
    suspend fun run(body: String, args: Map<String, Any?> = emptyMap(), anyTanaPage: Boolean = false): JsonElement
    fun load(url: String)
    val url: String? // where the page is now: host and path, for the sign-in log
    fun cookieNames(): List<String> // Tana's cookies, by name only: never a value
    suspend fun forgetCookies()
    fun keepCookies() // written to disk now: the app closed right after signing in must not lose it
}

// What the app keeps on this phone: the saved searches' order, Demo mode, translations
interface Store {
    fun get(key: String): String?
    fun set(key: String, value: String?)
}

class MemoryStore(private val map: MutableMap<String, String> = mutableMapOf()) : Store {
    override fun get(key: String) = map[key]
    override fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
}


// The microphone, recording AAC for dictation (Dictation)
interface Recorder {
    fun start() // throws when the microphone did not start
    fun level(): Float // 0...1 since the last sample
    fun stop(): ByteArray? // the recording, or null when there was none
    fun cancel()
}

// What only the platform can do, for the shared screens
interface Platform {
    val store: Store
    // what is kept on this phone in files of its own rather than in store: a value that grows (the translations), read
    // and written whole. The same as store unless the platform has better.
    val files: Store get() = store
    val chatgpt: ChatGPT
    val version: String
    val recorder: Recorder?
    val reduceMotion: Boolean // the system's animations off: every move of the app's still too
    suspend fun microphone(): Boolean // may the app record: asked once, then remembered by the system
    // the language a text is in (an ISO code) and how sure, or null; renderer/translate.js's detection, as NaturalLanguage on the iPhone
    suspend fun language(text: String): Pair<String, Float>?
    fun decode(image: ByteArray): ImageBitmap?
    // a tana:image:'s bytes, fetched as sdk/assets.js fetchImage does (Engine.image); token(refresh) is Tana's access
    // token, asked again fresh after a 401. Null where the platform fetches nothing, or when it did not come.
    suspend fun image(uri: String, token: suspend (refresh: Boolean) -> String): ByteArray? = null
    fun share(text: String)
    fun open(url: String)
    fun copy(text: String) // words on the clipboard (Connect your personal agent's URLs and instructions)
    // the clipboard's image as a JPEG, 2048 px at most, or null; read and made smaller off the main thread
    suspend fun pasteImage(): ByteArray?
    fun hasClipboardImage(): Boolean // what the clipboard holds, by its kind only: reading it would tell the user so
    // the widgets' copy of the Timeline (Engine.keepTimeline): drawn by the platform's widgets, null once it is forgotten.
    // Nothing where the platform has no widgets.
    suspend fun keepGlimpse(read: Glimpse?) {}
    @Composable fun rememberPhotoPicker(picked: (ByteArray) -> Unit): () -> Unit // a JPEG, 2048 px at most
    @Composable fun EngineView(modifier: Modifier) // the engine's web view: Tana's sign-in while signed out
    @Composable fun ChatGPTSignIn(done: () -> Unit, failed: (String) -> Unit)
}

// a value as JSON, for an engine call's arguments: strings, numbers, booleans, lists, maps and JSON itself
fun toJson(value: Any?): JsonElement = when (value) {
    null -> kotlinx.serialization.json.JsonNull
    is JsonElement -> value
    is String -> kotlinx.serialization.json.JsonPrimitive(value)
    is Number -> kotlinx.serialization.json.JsonPrimitive(value)
    is Boolean -> kotlinx.serialization.json.JsonPrimitive(value)
    is Map<*, *> -> JsonObject(value.entries.associate { (k, v) -> k.toString() to toJson(v) })
    is Iterable<*> -> kotlinx.serialization.json.JsonArray(value.map(::toJson))
    else -> throw IllegalArgumentException("not JSON: " + value::class.simpleName)
}

// The script that runs an engine call in the page: the body as an async function's with the arguments by name, its
// answer (or what it threw) posted back with the call's number to the app's listener (orbitalAndroid, a web message
// listener allowed only on Tana's origin). The arguments go in as one JSON string literal, so nothing in them is code.
object Bridge {
    const val LISTENER = "orbitalAndroid"
    const val ORIGIN = "https://home.tana.inc"

    // A message the listener may act on: from Tana's own origin, and from the page itself rather than a frame in it
    // (docs/ANDROID.md: the origin rule is the first check, not the only one)
    fun trusted(origin: String?, mainFrame: Boolean): Boolean = mainFrame && origin?.trimEnd('/') == ORIGIN

    // The one page engine.js runs on (ios/engine/build.js), as Engine.swift isSessionPage: a message is acted on, and a
    // call made, only while it is the page in the view, never a page that took its place (security review finding 6)
    fun onSessionPage(url: String?): Boolean = url != null && url.substringBefore('#').substringBefore('?') == Engine.SESSION

    // What the page posted: a word of engine.js's own ('ready', 'changed'), or a call's answer by its number
    sealed interface Heard {
        data class Said(val message: String) : Heard
        data class Answer(val id: Int, val value: JsonElement?, val error: String?) : Heard // value when it returned, error when it threw
    }

    fun read(data: String): Heard? {
        if (!data.startsWith("{")) return Heard.Said(data)
        val answer = runCatching { json.parseToJsonElement(data) as? JsonObject }.getOrNull() ?: return null
        val id = (answer["id"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull() ?: return null
        val ok = (answer["ok"] as? kotlinx.serialization.json.JsonPrimitive)?.content == "true"
        return if (ok) Heard.Answer(id, answer["value"] ?: kotlinx.serialization.json.JsonNull, null)
        else Heard.Answer(id, null, (answer["error"] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content ?: "The engine failed")
    }

    fun script(id: Int, body: String, args: Map<String, Any?>): String {
        val names = args.keys.onEach { require(Regex("[A-Za-z_][A-Za-z0-9_]*").matches(it)) { "not a name: " + it } }.joinToString(", ")
        val values = kotlinx.serialization.json.JsonPrimitive(JsonObject(args.mapValues { toJson(it.value) }).toString()).toString()
        return "(async ({ " + names + " }) => { " + body + "\n})(JSON.parse(" + values + "))" +
            ".then((value) => " + LISTENER + ".postMessage(JSON.stringify({ id: " + id + ", ok: true, value: value === undefined ? null : value }))," +
            " (e) => " + LISTENER + ".postMessage(JSON.stringify({ id: " + id + ", ok: false, error: String((e && e.message) || e) })));"
    }

    // before engine.js: what it says to the iPhone's message handler goes to the Android app's listener
    const val SHIM = "window.webkit = window.webkit || { messageHandlers: { orbital: { postMessage: (m) => window." + LISTENER + " && " + LISTENER + ".postMessage(String(m)) } } };\n"
}
