package com.dreetje.orbital

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

// Auto-translate as the desktop has it (#547; renderer/translate.js, main/ai.js translate): titles in another language
// shown in the language chosen in Orbital (a synced preference), on screen only; nothing is ever saved over them. The
// phone tells which are in another language itself (Platform.language) and asks ChatGPT for those only. Every answer
// is kept on this phone (store: Platform.files), so a title is asked once. What is marked sensitive is never sent to
// the model.
@Stable
class Translator(private val store: Store, private val chatgpt: ChatGPT, private val detect: suspend (String) -> Pair<String, Float>?, private val scope: CoroutineScope) {
    @Serializable data class Answer(val lang: String, val text: String) // text "": nothing to translate

    var to by mutableStateOf<String?>(null)
        private set
    // the synced Regular AI (model, effort: reading an image) and Quick AI (quickModel, quickEffort: translating)
    // (main/settings.js AI_KEYS); main/ai.js DEFAULT_MODEL / QUICK_MODEL and their efforts until they name others
    var ai by mutableStateOf(mapOf("model" to "gpt-5.6-terra", "effort" to "low", "quickModel" to "gpt-6-luna", "quickEffort" to "low"))
        private set
    private val answers = mutableStateMapOf<String, Answer>().apply {
        store.get("translations")?.let { saved -> maybeDecode(saved)?.let { putAll(it) } }
    }
    private val asked = mutableSetOf<String>()
    private val queue = mutableListOf<Pair<String, String>>() // each with its language: Auto-translate can change while it waits
    private var flushing = false
    var problem by mutableStateOf<String?>(null) // why the last question to ChatGPT got no answer
        private set

    // What ChatGPT is asked with and how Settings names the models, from the engine as the Mac has them (main/prompts.js,
    // orbital.prompts; Translator.swift Prompts): read again when the language or the models change (Engine.loadPrompts).
    // None in the sample, which has no engine: nothing is translated there, and a model goes by its id.
    @Serializable class Prompts(val translate: Translate? = null, val image: Image, val models: Map<String, String> = emptyMap(), val efforts: Map<String, String> = emptyMap()) {
        @Serializable class Translate(val instructions: String, val schema: kotlinx.serialization.json.JsonObject)
        @Serializable class Image(val instructions: String)
        var to: String? = null // the language they were asked for
    }
    var prompts by mutableStateOf<Prompts?>(null)
    fun label(model: String) = prompts?.models?.get(model) ?: model
    fun effortLabel(effort: String) = prompts?.efforts?.get(effort) ?: effort

    fun use(to: String?, ai: Map<String, String> = emptyMap()) {
        this.to = to
        this.ai = this.ai + ai
        fit()
    }

    // This account's models, once read: a synced choice off them is asked as the start choice instead, as main/ai.js chosen does
    var catalogue: List<ChatGPT.Model> = emptyList()
        set(value) { field = value; fit() }

    private fun fit() {
        if (catalogue.isEmpty()) return
        val next = ai.toMutableMap()
        for ((m, e, start, startEffort) in listOf(listOf("model", "effort", "gpt-5.6-terra", "low"), listOf("quickModel", "quickEffort", "gpt-6-luna", "low"))) {
            val model = catalogue.firstOrNull { it.id == next[m] } ?: catalogue.firstOrNull { it.id == start } ?: catalogue[0]
            next[m] = model.id
            if (next[e] !in model.levels) next[e] = if (startEffort in model.levels) startEffort else model.levels[0]
        }
        ai = next
    }

    // The words to show and, when they are a translation, the language they were in. Asks for what it does not know yet.
    fun words(text: String, sensitive: Boolean = false): Pair<String, String?> {
        val to = to
        if (to == null || sensitive || text.isBlank()) return text to null
        val key = to + "\n" + text
        answers[key]?.let { return if (it.text.isEmpty()) text to null else it.text to it.lang }
        if (asked.add(key)) {
            queue.add(to to text)
            if (!flushing) { flushing = true; scope.launch { delay(300); flush() } } // one question per screen
        }
        return text to null
    }

    private suspend fun foreign(text: String, to: String): Boolean {
        val (lang, sure) = detect(text) ?: return false
        if (sure < 0.6f) return false // main/ai.js DETECT_SURE: too short or all names to say, shown as written
        return lang.substringBefore('-') != CODES[to]
    }

    // one language a question: the first waiting one's, the rest (more of it, or another language) in the next
    private suspend fun flush() {
        val to = queue.firstOrNull()?.first ?: run { flushing = false; return }
        val batch = queue.filter { it.first == to }.map { it.second }.distinct().take(200).toSet()
        queue.removeAll { it.first == to && it.second in batch }
        flushing = queue.isNotEmpty()
        if (flushing) scope.launch { flush() }
        val none = Answer("", "")
        for (text in batch) if (!foreign(text, to)) answers[to + "\n" + text] = none
        val ask = batch.filter { answers[to + "\n" + it] == null }
        if (ask.isEmpty()) return save()
        // the engine's words for this language not read yet (or the sample, which has none): asked again another time
        val words = prompts?.takeIf { it.to == to }?.translate ?: run {
            ask.forEach { asked.remove(to + "\n" + it) }
            return save()
        }
        val found = try {
            ChatGPT.translate(chatgpt, ask, words.instructions, words.schema, ai.getValue("quickModel"), ai.getValue("quickEffort")) ?: run {
                problem = "Sign in with ChatGPT"
                ask.forEach { asked.remove(to + "\n" + it) } // asked again once signed in
                return save()
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            problem = "ChatGPT: " + e.message
            ask.forEach { asked.remove(to + "\n" + it) } // asked again on the next screen that shows it
            return save()
        }
        problem = null
        ask.forEachIndexed { i, text ->
            val answer = found[i + 1] ?: run { asked.remove(to + "\n" + text); return@forEachIndexed } // not answered: asked again another time
            answers[to + "\n" + text] = if (answer.text == text || answer.lang.equals(to, ignoreCase = true)) none else answer
        }
        save()
    }

    // ponytail: every answer kept for ever; a cap or an age when the store grows large
    private fun save() = store.set("translations", json.encodeToString(answers.toMap()))

    private fun maybeDecode(saved: String): Map<String, Answer>? = runCatching { json.decodeFromString<Map<String, Answer>>(saved) }.getOrNull()

    companion object {
        val LANGUAGES = listOf("English", "Dutch", "German", "French", "Spanish") // renderer/translate.js TRANSLATE_LANGS
        private val CODES = mapOf("English" to "en", "Dutch" to "nl", "German" to "de", "French" to "fr", "Spanish" to "es")
    }
}
