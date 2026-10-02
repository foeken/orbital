package com.dreetje.orbital

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// The engine's page, faked: each call answered by what answer says for its body, every call kept
class FakeHost(var answer: (String, Map<String, Any?>) -> JsonElement = { _, _ -> JsonNull }) : EngineHost {
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

class FakeAI : AI {
    override fun account(): AI.Account? = null
    override fun forget() {}
    override suspend fun models(): List<AI.Model>? = null
    override suspend fun respond(instructions: String, content: List<JsonObject>, model: String, effort: String, schema: JsonObject?): String? = null
    override suspend fun transcribe(audio: ByteArray): String? = null
}

class FakePlatform(override val store: Store = MemoryStore()) : Platform {
    override val ai: AI = FakeAI()
    override val version = "test"
    override val recorder: Recorder? = null
    override val reduceMotion = true
    var shared = mutableListOf<String>()
    override suspend fun microphone() = false
    override suspend fun language(text: String): Pair<String, Float>? = null
    override fun decode(image: ByteArray): ImageBitmap? = null
    override fun share(text: String) { shared += text }
    override fun open(url: String) {}
    override fun clipboardImage(): ByteArray? = null
    override fun hasClipboardImage() = false
    @Composable override fun rememberPhotoPicker(picked: (ByteArray) -> Unit): () -> Unit = {}
    @Composable override fun EngineView(modifier: Modifier) {}
    @Composable override fun ChatGPTSignIn(done: () -> Unit, failed: (String) -> Unit) {}
}
