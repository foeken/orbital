package com.dreetje.orbital.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.dreetje.orbital.Dictation
import com.dreetje.orbital.Engine
import kotlinx.coroutines.launch

// The controls of the iPhone's ios/Orbital/Dictation.swift; what they drive is com.dreetje.orbital.Dictation

// The controls: a microphone to start; while listening ✕ to throw the recording away, the dots, and ■ to stop (Codex's
// own dictation bar); a spinner while the words are being written down
@Composable
fun RowScope.Dictate(dictation: Dictation, engine: Engine, into: (String) -> Unit) {
    val c = Theme.colors
    when {
        dictation.recording -> {
            Round(Icons.Filled.Close, "Cancel dictation") { dictation.cancel() }
            Listening(dictation.levels, Modifier.weight(1f))
            Round(Icons.Filled.Stop, "Stop dictating") { dictation.finish(into) }
        }
        dictation.transcribing -> CircularProgressIndicator(Modifier.size(24.dp), color = c.secondary, strokeWidth = 2.dp)
        else -> RoundButton("Dictate", 34.dp, Color.Transparent, onClick = { engine.scope.launch { dictation.listen() } }) {
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
    RoundButton(label, 32.dp, c.fill, onClick = onClick) {
        Icon(icon, null, Modifier.size(16.dp), c.text)
    }
}
