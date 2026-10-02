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
    }

    // body run as an async function's in the page, args bound by name (callAsyncJavaScript on the iPhone): what it
    // returned, as JSON. Throws what the engine threw.
    suspend fun run(body: String, args: Map<String, Any?> = emptyMap()): JsonElement
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

// Your ChatGPT account, for Auto-translate, reading an image and dictation, as Codex asks ChatGPT (ios/Orbital/Translator.swift).
// The Android app's is ChatGPTClient; null answers mean signed out.
interface AI {
    data class Account(val email: String?, val plan: String?)
    data class Model(val id: String, val efforts: List<String>) {
        // a model listed without its levels takes these, as main/ai.js EFFORTS
        val levels: List<String> get() = efforts.ifEmpty { listOf("low", "medium", "high") }
    }

    fun account(): Account?
    fun forget()
    suspend fun models(): List<Model>?
    // one question, its answer's text; content: the user's parts (input_text, input_image); schema: the answer's shape
    suspend fun respond(instructions: String, content: List<JsonObject>, model: String, effort: String, schema: JsonObject? = null): String?
    suspend fun transcribe(audio: ByteArray): String?
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
    val ai: AI
    val version: String
    val recorder: Recorder?
    val reduceMotion: Boolean // the system's animations off: every move of the app's still too
    suspend fun microphone(): Boolean // may the app record: asked once, then remembered by the system
    // the language a text is in (an ISO code) and how sure, or null; renderer/translate.js's detection, as NaturalLanguage on the iPhone
    suspend fun language(text: String): Pair<String, Float>?
    fun decode(image: ByteArray): ImageBitmap?
    fun share(text: String)
    fun open(url: String)
    fun clipboardImage(): ByteArray? // as a JPEG, 2048 px at most, or null
    fun hasClipboardImage(): Boolean // what the clipboard holds, by its kind only: reading it would tell the user so
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
