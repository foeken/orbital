package com.dreetje.orbital

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

// Dictation in Quick Add and the Ask Tana composer, as Codex dictates (ios/Orbital/Dictation.swift): the microphone
// recorded with its level sampled for the dots that move while you speak, then sent to ChatGPT as a whole once stopped,
// its words handed to whoever is being dictated into.
@Stable
class Dictation(private val platform: Platform, private val scope: CoroutineScope) {
    var levels by mutableStateOf(List(DOTS) { 0f }) // 0...1, newest last
        private set
    var recording by mutableStateOf(false)
        private set
    var transcribing by mutableStateOf(false)
        private set
    var problem by mutableStateOf<String?>(null) // why listening or writing down did not work, to show under the box
        private set
    var settling by mutableStateOf(false) // Add, Send or Assign pressed while dictating: the words are being waited for
        private set
    val busy: Boolean get() = recording || transcribing // listening, or writing down what was said
    private var heard: Deferred<Boolean>? = null
    private var meter: Job? = null
    private var wanted = false // listening asked for and not cancelled since: Android's question can outlast the page

    // the microphone button: listening, once ChatGPT and the microphone may be used
    suspend fun listen() {
        problem = null
        wanted = true
        if (platform.chatgpt.account() == null) { problem = "Sign in with ChatGPT in Settings to dictate"; return }
        if (!platform.microphone()) { problem = "Allow Orbital the microphone in Android's settings to dictate"; return }
        // cancelled while Android asked (the page left, or ✕): no recording that nothing would stop
        if (!wanted) return
        val recorder = platform.recorder ?: run { problem = "This phone has no microphone"; return }
        try { recorder.start() } catch (e: Exception) { problem = e.message ?: "The microphone did not start"; return }
        recording = true
        meter = scope.launch { while (isActive) { delay(60); levels = levels.drop(1) + recorder.level() } }
    }

    // stop: listening stops and the recording is written down, its words handed to into once they come
    // false when there was nothing to write down: a recording too short for Android to keep, which it says
    fun finish(into: (String) -> Unit): Boolean {
        val audio = stop() ?: run { problem = "Too short to write down. Try again."; return false }
        transcribing = true
        heard = scope.async {
            try {
                val text = platform.chatgpt.transcribe(audio) ?: run { problem = "Sign in with ChatGPT in Settings to dictate"; return@async false }
                text.trim().takeIf { it.isNotEmpty() }?.let(into)
                true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                problem = "Dictation: " + e.message
                false
            } finally {
                transcribing = false
                heard = null
            }
        }
        return true
    }

    // Add or send while listening or writing down: the words are waited for; false when they did not come, so what
    // was said is never lost without a word
    suspend fun settle(into: (String) -> Unit): Boolean {
        if (recording && !finish(into)) return false
        return heard?.await() ?: true
    }

    // Quick Add's Add, the composer's Send and Assign to's Assign (ios/Orbital/Dictation.swift the same): pressed while
    // listening or writing down, the words are waited for and added to what is typed (into), and settling says so
    // meanwhile; false when they did not come, so what was said is never sent without it. At once when nothing is dictated.
    suspend fun settled(into: (String) -> Unit): Boolean {
        if (!busy) return true
        settling = true
        try { return settle(into) } finally { settling = false }
    }

    private fun stop(): ByteArray? {
        if (!recording) return null
        val audio = platform.recorder?.stop()
        end()
        return audio
    }

    fun cancel() {
        wanted = false
        if (recording) platform.recorder?.cancel()
        end()
    }

    private fun end() {
        meter?.cancel(); meter = null
        recording = false
        levels = List(DOTS) { 0f }
    }

    companion object {
        const val DOTS = 28
        // dictated words after what is typed, a space between
        fun join(typed: String, said: String) = if (typed.isEmpty()) said else "$typed $said"
    }
}
