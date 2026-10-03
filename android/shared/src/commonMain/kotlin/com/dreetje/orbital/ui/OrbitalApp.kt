package com.dreetje.orbital.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import com.dreetje.orbital.Engine
import kotlinx.coroutines.launch

// The iPhone's ios/Orbital/OrbitalApp.swift: the app, the one web view, and what sign-in did

// How the app opens, for design shots and tests (the iPhone's launch arguments): a node zoomed into, Settings or Quick
// Add open, the menu opened and closed again
data class Start(val zoom: String? = null, val settings: Boolean = false, val add: Boolean = false, val menuDemo: Boolean = false)

// The app: one web view in one place, Tana's sign-in while signed out and hidden behind the app once the engine runs;
// the app's frame once it starts, its Timeline building itself while Tana connects
@Composable
fun OrbitalApp(engine: Engine, start: Start = Start()) {
    OrbitalTheme {
        val c = Theme.colors
        var details by remember { mutableStateOf(false) }
        val signingIn = engine.phase == Engine.Phase.SignedOut
        Box(Modifier.fillMaxSize().background(c.page)) {
            Column(if (signingIn) Modifier.fillMaxSize() else Modifier.size(1.dp).alpha(0f).clearAndSetSemantics {}) {
                if (signingIn) Box(Modifier.fillMaxWidth().statusBarsPadding().height(52.dp)) {
                    Text("Sign in to Tana", Modifier.align(Alignment.Center), style = Type.headline, color = c.text)
                    TextButton({ details = true }, Modifier.align(Alignment.CenterEnd)) { Text("Details", color = c.text) }
                }
                engine.platform.EngineView(Modifier.fillMaxWidth().weight(1f).navigationBarsPadding().imePadding())
            }
            when (val phase = engine.phase) {
                is Engine.Phase.Failed -> Empty("Can't reach Tana", phase.message, Modifier.statusBarsPadding(), icon = Icons.Outlined.WifiOff) {
                    Button({ engine.start() }, colors = ButtonDefaults.buttonColors(containerColor = c.text, contentColor = c.page)) { Text("Try again") }
                    TextButton({ details = true }) { Text("Details", color = c.text) }
                }
                Engine.Phase.SignedOut -> {}
                else -> Shell(engine, start)
            }
        }
        if (details) SignInLog(engine.log.toList(), engine.platform::share) { details = false }
    }
}

@Composable
fun SignInLog(lines: List<String>, share: (String) -> Unit, onDismiss: () -> Unit) {
    val c = Theme.colors
    val text = lines.joinToString("\n")
    Sheet(onDismiss) { close ->
        SheetBar("Sign-in details", cancel = close, action = "Share") { share(text) }
        LazyColumn(Modifier.fillMaxWidth()) {
            item {
                androidx.compose.foundation.text.selection.SelectionContainer {
                    Text(text.ifEmpty { "Nothing yet." }, Modifier.fillMaxWidth().padding(16.dp), style = Type.footnote.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace), color = c.text)
                }
            }
        }
    }
}
