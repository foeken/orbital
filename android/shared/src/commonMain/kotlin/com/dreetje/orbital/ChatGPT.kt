package com.dreetje.orbital

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.io.encoding.Base64

// Your ChatGPT account, as ios/Orbital's enum ChatGPT (Settings.swift, Translator.swift, QuickAdd.swift): what the app asks
// of it, as Codex asks ChatGPT, is the platform's to do (ChatGPTClient on Android); null answers mean signed out. Its
// companion asks it with the engine's words (orbital.prompts, Translator.Prompts).
interface ChatGPT {
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

    // an image read into { kind, title, notes } (readImage)
    @Serializable data class Read(val kind: String? = null, val title: String? = null, val notes: List<String>? = null)

    // What Orbital asks ChatGPT with (the instructions, the answer's schema) is the engine's (orbital.prompts, main/prompts.js),
    // as on the Mac and the iPhone: Translator.prompts holds it
    companion object {
        @Serializable private data class Out(val translations: List<One>) { @Serializable data class One(val id: Int, val lang: String? = null, val text: String? = null) }

        // Translations by id: id -> { lang, text }, a text already in the language kept as nothing to translate. null without a sign-in.
        suspend fun translate(chatgpt: ChatGPT, texts: List<String>, instructions: String, schema: JsonObject, model: String, effort: String): Map<Int, Translator.Answer>? {
            val input = JsonArray(texts.mapIndexed { i, t -> buildJsonObject { put("id", i + 1); put("text", t) } }).toString()
            val answer = chatgpt.respond(instructions, listOf(part("input_text", "text", input)), model, effort, schema) ?: return null
            return json.decodeFromString<Out>(answer).translations.associate { it.id to Translator.Answer(it.lang ?: "", if (it.lang == null) "" else it.text ?: "") }
        }

        // main/ai.js readImage: the image read into { kind, title, notes }, with the engine's instructions (IMAGE_INSTRUCTIONS,
        // written in the language Auto-translate shows notes in)
        suspend fun readImage(chatgpt: ChatGPT, jpeg: ByteArray, instructions: String, model: String, effort: String): Read {
            val answer = chatgpt.respond(instructions, listOf(part("input_text", "text", "The image is attached."),
                part("input_image", "image_url", "data:image/jpeg;base64," + Base64.encode(jpeg))), model, effort)
                ?: throw Failure("Sign in with ChatGPT in Settings to process images")
            val from = answer.indexOf('{')
            val until = answer.lastIndexOf('}')
            val read = if (from >= 0 && until > from) runCatching { json.decodeFromString<Read>(answer.substring(from, until + 1)) }.getOrNull() else null
            if (read?.title?.trim().isNullOrEmpty()) throw Failure("ChatGPT read nothing useful from the image")
            return read
        }

        private fun part(type: String, key: String, value: String) = buildJsonObject { put("type", type); put(key, value) }
    }
}
