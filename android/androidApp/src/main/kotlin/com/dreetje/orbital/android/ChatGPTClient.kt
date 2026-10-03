package com.dreetje.orbital.android

import com.dreetje.orbital.AI
import com.dreetje.orbital.Failure
import com.dreetje.orbital.json
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID

// ChatGPT as Codex asks it, for Auto-translate, reading an image and dictation (ios/Orbital/Settings.swift ChatGPT,
// Translator.swift): sign-in with PKCE against auth.openai.com with Codex's client id, the access token renewed a
// minute before it runs out, the Responses endpoint streamed. The tokens stay on this phone, sealed by the Keystore.
// ponytail: Codex's client id, fine for a personal build; Orbital's own id once registered with OpenAI (#664).
class ChatGPTClient(private val secrets: Secrets) : AI {
    @Serializable
    data class Tokens(@SerialName("id_token") val idToken: String, @SerialName("access_token") val accessToken: String, @SerialName("refresh_token") val refreshToken: String)

    private fun load(): Tokens? = secrets.get(KEY)?.let { runCatching { json.decodeFromString<Tokens>(it) }.getOrNull() }
    fun save(tokens: Tokens) = secrets.set(KEY, json.encodeToString(tokens))
    override fun forget() = secrets.set(KEY, null)

    // one renewal at a time: a refresh token is good for one use, so a second renewal at the same moment (Auto-translate
    // and the models list as the app starts) would be refused with it; the one waiting reads what the first saved
    private val renewing = Mutex()

    override fun account(): AI.Account? = load()?.let { t ->
        val claims = claims(t.idToken)
        val auth = claims["https://api.openai.com/auth"] as? JsonObject
        AI.Account(claims["email"]?.jsonPrimitive?.contentOrNull, auth?.get("chatgpt_plan_type")?.jsonPrimitive?.contentOrNull)
    }

    // The account with a live access token: renewed with its refresh token a minute before it runs out (codex-rs/login,
    // the refresh_token grant); null when signed out. A refresh refused leaves the account as it was.
    private suspend fun fresh(): Tokens? { return renewing.withLock {
        val t = load() ?: return null
        val exp = claims(t.accessToken)["exp"]?.jsonPrimitive?.doubleOrNull ?: 0.0
        if (exp * 1000 > System.currentTimeMillis() + 60_000) return t
        val (status, body) = post(ISSUER + "/oauth/token", form(mapOf("grant_type" to "refresh_token", "client_id" to CLIENT, "refresh_token" to t.refreshToken)), "application/x-www-form-urlencoded")
        if (status != 200) throw Failure("ChatGPT did not renew the sign-in (HTTP $status)")
        val r = json.parseToJsonElement(body).jsonObject
        fun field(name: String) = r[name]?.jsonPrimitive?.contentOrNull
        Tokens(field("id_token") ?: t.idToken, field("access_token") ?: t.accessToken, field("refresh_token") ?: t.refreshToken).also(::save)
    } }

    // the code for tokens, as codex-rs/login exchange_code_for_tokens posts it
    suspend fun exchange(code: String, verifier: String): Tokens {
        val (status, body) = post(ISSUER + "/oauth/token", form(mapOf("grant_type" to "authorization_code", "code" to code, "redirect_uri" to REDIRECT, "client_id" to CLIENT, "code_verifier" to verifier)), "application/x-www-form-urlencoded")
        if (status != 200) throw Failure("HTTP $status")
        return json.decodeFromString(body)
    }

    // The models to choose from: ChatGPT's own list of Codex models at a high client_version, each with its thinking levels
    override suspend fun models(): List<AI.Model>? {
        val t = fresh() ?: return null
        val (status, body) = get("https://chatgpt.com/backend-api/codex/models?client_version=99.0.0", mapOf("authorization" to "Bearer " + t.accessToken))
        if (status != 200) throw Failure("HTTP $status")
        @Serializable data class Level(val effort: String)
        @Serializable data class M(val slug: String, val visibility: String? = null, @SerialName("supported_reasoning_levels") val levels: List<Level>? = null)
        @Serializable data class Out(val models: List<M>)
        return json.decodeFromString<Out>(body).models.filter { it.visibility != "hide" }.map { AI.Model(it.slug, (it.levels ?: emptyList()).map(Level::effort)) }
    }

    // One question to ChatGPT as Codex asks it (its Responses endpoint for a ChatGPT sign-in, streamed): the answer's text
    override suspend fun respond(instructions: String, content: List<JsonObject>, model: String, effort: String, schema: JsonObject?): String? {
        val t = fresh() ?: return null
        val body = buildJsonObject {
            put("model", model); put("instructions", instructions); put("store", false); put("stream", true)
            put("reasoning", buildJsonObject { put("effort", effort) })
            put("input", buildJsonArray { add(buildJsonObject { put("type", "message"); put("role", "user"); put("content", buildJsonArray { content.forEach { add(it) } }) }) })
            if (schema != null) put("text", buildJsonObject { put("format", buildJsonObject { put("type", "json_schema"); put("name", "answer"); put("schema", schema); put("strict", true) }) })
        }.toString()
        val headers = headers(t) + mapOf("OpenAI-Beta" to "responses=experimental", "accept" to "text/event-stream", "content-type" to "application/json")
        return request("https://chatgpt.com/backend-api/codex/responses", headers, 90_000, body.toByteArray()) { c ->
            if (c.responseCode != 200) throw Failure("HTTP " + c.responseCode)
            val answer = StringBuilder()
            c.inputStream.bufferedReader().useLines { lines ->
                for (line in lines) {
                    if (!line.startsWith("data: ")) continue
                    val event = runCatching { json.parseToJsonElement(line.drop(6)).jsonObject }.getOrNull() ?: continue
                    if (event["type"]?.jsonPrimitive?.contentOrNull == "response.output_text.delta") event["delta"]?.jsonPrimitive?.contentOrNull?.let(answer::append)
                }
            }
            answer.toString()
        }
    }

    // Dictation: the recording as text, from ChatGPT's own transcription, the one Codex dictates with. It picks the
    // model: naming one is refused there.
    override suspend fun transcribe(audio: ByteArray): String? {
        val t = fresh() ?: return null
        val boundary = UUID.randomUUID().toString()
        val body = ByteArrayOutputStream().apply {
            write("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"dictation.m4a\"\r\nContent-Type: audio/mp4\r\n\r\n".toByteArray())
            write(audio)
            write("\r\n--$boundary--\r\n".toByteArray())
        }.toByteArray()
        val headers = headers(t) + mapOf("user-agent" to "codex_cli_rs/0.130.0 (Android; arm64)", "accept" to "application/json", "content-type" to "multipart/form-data; boundary=$boundary")
        return request("https://chatgpt.com/backend-api/transcribe", headers, 60_000, body) { c ->
            if (c.responseCode != 200) throw Failure("HTTP " + c.responseCode)
            json.parseToJsonElement(c.inputStream.bufferedReader().use { it.readText() }).jsonObject["text"]?.jsonPrimitive?.contentOrNull ?: ""
        }
    }

    private fun headers(t: Tokens): Map<String, String> {
        val auth = claims(t.idToken)["https://api.openai.com/auth"] as? JsonObject
        return mapOf("authorization" to "Bearer " + t.accessToken, "chatgpt-account-id" to (auth?.get("chatgpt_account_id")?.jsonPrimitive?.contentOrNull ?: ""), "originator" to "codex_cli_rs")
    }

    // One request on a connection of its own, off the main thread, disconnected once read or once the asking is
    // cancelled (URLSession's own on the iPhone): a read blocked on the socket never sees the cancellation, and closing
    // the connection under it is what ends it
    private suspend fun <T> request(url: String, headers: Map<String, String>, timeout: Int, body: ByteArray?, read: (HttpURLConnection) -> T): T = coroutineScope {
        val c = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = timeout
            headers.forEach { (k, v) -> setRequestProperty(k, v) }
        }
        val work = async(Dispatchers.IO) {
            if (body != null) { c.doOutput = true; c.outputStream.use { it.write(body) } }
            read(c)
        }
        try { work.await() } finally { c.disconnect() }
    }

    // the status and the body, the error's own when it failed
    private fun text(c: HttpURLConnection): Pair<Int, String> =
        c.responseCode to (if (c.responseCode in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()

    private suspend fun get(url: String, headers: Map<String, String>): Pair<Int, String> = request(url, headers, 30_000, null, ::text)

    private suspend fun post(url: String, body: String, type: String): Pair<Int, String> = request(url, mapOf("content-type" to type), 30_000, body.toByteArray(), ::text)

    companion object {
        private const val KEY = "chatgpt"
        const val ISSUER = "https://auth.openai.com"
        const val CLIENT = "app_EMoamEEZ73f0CkXaXp7hrann"
        const val REDIRECT = "http://localhost:1455/auth/callback"
        const val SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke"

        fun base64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        fun random(): String = base64url(ByteArray(32).also(SecureRandom()::nextBytes))

        // A form posted to the token endpoint: every value encoded, a + included (a form body reads it as a space)
        fun form(fields: Map<String, String>) = fields.entries.joinToString("&") { (k, v) -> URLEncoder.encode(k, "UTF-8") + "=" + URLEncoder.encode(v, "UTF-8") }

        fun authorize(verifier: String, state: String): String {
            val challenge = base64url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))
            return ISSUER + "/oauth/authorize?" + form(linkedMapOf(
                "response_type" to "code", "client_id" to CLIENT, "redirect_uri" to REDIRECT, "scope" to SCOPE, "code_challenge" to challenge,
                "code_challenge_method" to "S256", "id_token_add_organizations" to "true", "codex_cli_simplified_flow" to "true", "state" to state, "originator" to "codex_cli_rs",
            )).replace("+", "%20")
        }

        fun claims(jwt: String): JsonObject = runCatching {
            json.parseToJsonElement(String(Base64.getUrlDecoder().decode(jwt.split(".")[1].trimEnd('=')))).jsonObject
        }.getOrDefault(JsonObject(emptyMap()))
    }
}
