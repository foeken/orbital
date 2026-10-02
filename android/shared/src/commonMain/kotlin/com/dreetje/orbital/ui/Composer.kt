package com.dreetje.orbital.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.dreetje.orbital.Dictation
import com.dreetje.orbital.Engine
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

// The composer, as the Codex app has it: what you type goes to Tana, as a new chat from the page (Shell) or a follow-up
// in a chat (NodeScreen). A capsule at rest, a card while you type in it, the words on top and send in its corner.
// The words go the moment it is sent, and come back with the reason if Tana refuses them; a message sent that Tana did
// not answer stays sent, with the warning send hands back shown over the box.
@Composable
fun Composer(engine: Engine, prompt: String = "Ask Tana", note: String? = null, send: suspend (String) -> String?) {
    val c = Theme.colors
    val still = engine.platform.reduceMotion
    var text by rememberSaveable { mutableStateOf("") }
    var failure by remember { mutableStateOf(note) }
    var sending by remember { mutableStateOf(false) }
    var focused by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val dictation = remember { Dictation(engine.platform, engine.scope) }
    DisposableEffect(Unit) { onDispose { dictation.cancel() } } // the page left while listening: nothing kept
    val empty = text.isBlank()
    val busy = dictation.recording || dictation.transcribing // listening, or writing down what was said
    val open = focused || !empty || busy
    val side by animateDpAsState(if (open) 14.dp else 36.dp, if (still) tween(0) else tween(240))
    val shape = RoundedCornerShape(23.dp)
    fun append(said: String) { text = if (text.isEmpty()) said else "$text $said" } // dictated words land after what is typed

    // Send while listening or writing down too: listening stops and the words are waited for first
    suspend fun submit() {
        if (busy) {
            sending = true
            val heard = dictation.settle(::append)
            sending = false
            if (!heard) return
        }
        val words = text.trim()
        if (words.isEmpty()) return
        text = ""; focus.clearFocus(); sending = true
        try {
            failure = send(words)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            text = if (text.isEmpty()) words else words + "\n\n" + text // the unsent words come back, ahead of anything typed since
            failure = e.message
        }
        sending = false
    }

    Column(Modifier.fillMaxWidth().padding(horizontal = side).padding(top = 4.dp, bottom = if (focused) 10.dp else 6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        val line = failure ?: dictation.problem
        if (line != null) Text(line, Modifier.padding(bottom = 6.dp), style = Type.footnote, color = c.secondary, textAlign = TextAlign.Center)
        Box(Modifier.fillMaxWidth().shadow(if (c.dark) 0.dp else 8.dp, shape, ambientColor = Color.Black.copy(0.08f), spotColor = Color.Black.copy(0.12f))
            .clip(shape).background(c.card).border(1.dp, c.separator, shape).animateContentSize(if (still) tween(0) else tween(240))) {
            BasicTextField(
                text, { text = it },
                Modifier.fillMaxWidth().heightIn(min = 46.dp).onFocusChanged { focused = it.isFocused }
                    .padding(start = 18.dp, end = if (open) 18.dp else 52.dp, top = if (open) 15.dp else 12.dp, bottom = if (open) 58.dp else 12.dp)
                    .semantics { contentDescription = prompt },
                textStyle = Type.body.copy(color = c.text), cursorBrush = SolidColor(c.accent), maxLines = 6,
                decorationBox = { inner -> Box { if (text.isEmpty()) Text(prompt, style = Type.body, color = c.secondary); inner() } },
            )
            // the card's bottom row: dictating, only while you are in the card (or it still listens), then send
            Row(Modifier.align(Alignment.BottomEnd).then(if (dictation.recording) Modifier.fillMaxWidth() else Modifier).padding(if (open) 10.dp else 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (focused || busy) Dictate(dictation, engine) { append(it) }
                Send(enabled = (!empty || busy) && !sending, label = prompt) { scope.launch { submit() } }
            }
        }
    }
}

// the Codex app's send: a grey circle while there is nothing to send, blue once there is
@Composable
fun Send(enabled: Boolean, label: String, onClick: () -> Unit) {
    val c = Theme.colors
    Box(Modifier.size(34.dp).clip(CircleShape).background(if (enabled) c.accent else c.fill).clickable(enabled = enabled, onClick = onClick)
        .semantics { contentDescription = label; role = Role.Button }, contentAlignment = Alignment.Center) {
        Icon(Icons.Filled.ArrowUpward, null, Modifier.size(20.dp), if (enabled) Color.White else c.tertiary)
    }
}

// The controls: a microphone to start; while listening ✕ to throw the recording away, the dots, and ■ to stop (Codex's
// own dictation bar); a spinner while the words are being written down
@Composable
fun RowScope.Dictate(dictation: Dictation, engine: Engine, into: (String) -> Unit) {
    val c = Theme.colors
    val scope = rememberCoroutineScope()
    when {
        dictation.recording -> {
            Round(Icons.Filled.Close, "Cancel dictation") { dictation.cancel() }
            Listening(dictation.levels, Modifier.weight(1f))
            Round(Icons.Filled.Stop, "Stop dictating") { dictation.finish(into) }
        }
        dictation.transcribing -> CircularProgressIndicator(Modifier.size(24.dp), color = c.secondary, strokeWidth = 2.dp)
        else -> Box(Modifier.size(34.dp).clip(CircleShape).clickable { engine.scope.launch { dictation.listen() } }.semantics { contentDescription = "Dictate"; role = Role.Button }, contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.Mic, null, Modifier.size(22.dp), c.text)
        }
    }
}

// The dots while recording: one per sample, newest on the right, each taller as you speak louder
@Composable
fun Listening(levels: List<Float>, modifier: Modifier = Modifier) {
    val c = Theme.colors
    Row(modifier.heightIn(min = 24.dp).semantics { contentDescription = "Listening" }, horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        levels.forEachIndexed { i, level ->
            val edge = minOf(i, levels.size - 1 - i).let { if (it < 2) 0.4f + 0.3f * it else 1f } // fading out at both ends
            Box(Modifier.width(4.dp).height(4.dp + 16.dp * level).alpha(edge).clip(CircleShape).background(c.secondary))
        }
    }
}

// A round grey button: ✕ and ■ while listening
@Composable
fun Round(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    val c = Theme.colors
    Box(Modifier.size(32.dp).clip(CircleShape).background(c.fill).clickable(onClick = onClick).semantics { contentDescription = label; role = Role.Button }, contentAlignment = Alignment.Center) {
        Icon(icon, null, Modifier.size(16.dp), c.text)
    }
}

@Composable
fun Gap(h: Int) = Spacer(Modifier.height(h.dp))
