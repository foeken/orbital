package com.dreetje.orbital

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// The engine's page, faked: each call answered by what answer says for its body (which may wait, as the page does),
// every call kept
class FakeHost(var answer: suspend (String, Map<String, Any?>) -> JsonElement = { _, _ -> JsonNull }) : EngineHost {
    override var listener: EngineHost.Listener? = null
    val calls = mutableListOf<Pair<String, Map<String, Any?>>>()
    val loaded = mutableListOf<String>()
    var cookiesForgotten = 0
    override suspend fun run(body: String, args: Map<String, Any?>): JsonElement { calls += body to args; return answer(body, args) }
    override fun load(url: String) { loaded += url }
    override val url: String? get() = loaded.lastOrNull()
    override fun cookieNames() = listOf("__session")
    override suspend fun forgetCookies() { cookiesForgotten++ }
    override fun keepCookies() {}
}

// engine.js answers a JSON string for most calls: as the page would
fun text(value: String) = JsonPrimitive(value)

class FakeChatGPT(private val signedIn: Boolean = false) : ChatGPT {
    override fun account(): ChatGPT.Account? = if (signedIn) ChatGPT.Account("me@example.com", "plus") else null
    override fun forget() {}
    override suspend fun models(): List<ChatGPT.Model>? = null
    override suspend fun respond(instructions: String, content: List<JsonObject>, model: String, effort: String, schema: JsonObject?): String? = null
    override suspend fun transcribe(audio: ByteArray): String? = null
}

// The microphone, faked: whether it started, and nothing recorded
class FakeRecorder : Recorder {
    var started = 0
    override fun start() { started++ }
    override fun level() = 0f
    override fun stop(): ByteArray? = null
    override fun cancel() {}
}

class FakePlatform(
    override val store: Store = MemoryStore(),
    override val chatgpt: ChatGPT = FakeChatGPT(),
    override val recorder: Recorder? = null,
    private val allowed: suspend () -> Boolean = { false }, // what Android's microphone question answers
) : Platform {
    override val version = "test"
    override val reduceMotion = true
    var shared = mutableListOf<String>()
    override suspend fun microphone() = allowed()
    override suspend fun language(text: String): Pair<String, Float>? = null
    override fun decode(image: ByteArray): ImageBitmap? = null
    override fun share(text: String) { shared += text }
    override fun open(url: String) {}
    override suspend fun pasteImage(): ByteArray? = null
    override fun hasClipboardImage() = false
    @Composable override fun rememberPhotoPicker(picked: (ByteArray) -> Unit): () -> Unit = {}
    @Composable override fun EngineView(modifier: Modifier) {}
    @Composable override fun ChatGPTSignIn(done: () -> Unit, failed: (String) -> Unit) {}
}
