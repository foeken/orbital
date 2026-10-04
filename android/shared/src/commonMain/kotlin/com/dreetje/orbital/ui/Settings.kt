package com.dreetje.orbital.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.dreetje.orbital.ChatGPT
import com.dreetje.orbital.Engine
import com.dreetje.orbital.Translator
import com.dreetje.orbital.maybe
import kotlinx.coroutines.launch

// The iPhone's ios/Orbital/Settings.swift: Settings and its Models page

// Settings, opened from the side menu, laid out as the ChatGPT app's: no title, a close button top right, rounded
// groups under grey headings, each row a line glyph, its words and its value in grey
@Composable
fun SettingsSheet(engine: Engine, onDismiss: () -> Unit) {
    val c = Theme.colors
    val ai = engine.platform.chatgpt
    var account by remember { mutableStateOf(ai.account()) }
    var signingIn by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    var models by remember { mutableStateOf(listOf<ChatGPT.Model>()) } // the choices for Models, read when signed in
    var showModels by remember { mutableStateOf(false) }
    var connecting by remember { mutableStateOf(false) } // Connect to your OpenAI Dot (Agents.kt)
    LaunchedEffect(account) {
        models = if (account == null) emptyList() else maybe { ai.models() } ?: emptyList()
        if (models.isNotEmpty()) engine.translator.catalogue = models // the choices shown are the ones asked
    }
    Sheet(onDismiss) { close ->
        if (signingIn) {
            SheetBar("Sign in with ChatGPT", cancel = { signingIn = false; failure = null })
            Box(Modifier.weight(1f).fillMaxWidth()) {
                engine.platform.ChatGPTSignIn(done = { account = ai.account(); signingIn = false; failure = null }, failed = { failure = it })
            }
            failure?.let { Notice(it) }
            return@Sheet
        }
        if (showModels) { Models(engine, models) { showModels = false }; return@Sheet }
        if (connecting) { ConnectDot(engine) { connecting = false }; return@Sheet }
        Box(Modifier.fillMaxWidth().padding(4.dp)) {
            IconButton(close, Modifier.align(Alignment.CenterEnd)) { Icon(Icons.Filled.Close, "Close", tint = c.text) }
        }
        LazyColumn {
            item("tana") {
                Group("Tana") { GroupRow(last = true) { Label("tana", "Account"); Text(engine.email ?: "Tana", color = c.secondary) } }
            }
            item("chatgpt") {
                Group("ChatGPT", footer = "Your ChatGPT account is for the AI in Orbital and for Codex on your hosts. It stays on this phone.") {
                    val a = account
                    if (a == null) GroupRow(last = true, onClick = { signingIn = true }) { Label("chatgpt", "Sign in with ChatGPT") }
                    else {
                        GroupRow(last = a.plan == null && models.isEmpty()) { Label("chatgpt", "Account"); Text(a.email ?: "ChatGPT", color = c.secondary) }
                        a.plan?.let { GroupRow(last = models.isEmpty()) { Label("license", "Plan"); Text(it.replaceFirstChar { ch -> ch.uppercase() }, color = c.secondary) } }
                        if (models.isNotEmpty()) GroupRow(last = true, onClick = { showModels = true }) {
                            Label("brain", "Models")
                            Text(listOf("quickModel", "model").joinToString(", ") { ChatGPT.label(engine.translator.ai[it] ?: "") }, color = c.secondary, maxLines = 1)
                        }
                    }
                }
            }
            item("agents") {
                AgentsGroup(engine) { connecting = true } // your Dot (Agents.kt)
            }
            item("orbital") {
                val notes = listOfNotNull(engine.translator.problem?.takeIf { engine.translator.to != null }?.let { "Auto-translate: $it" }, // why the last translation did not come
                    "Demo mode shows made-up words and names in place of yours, for showing Orbital to someone. Nothing is saved to Tana while it is on.",
                    "Show sensitive items shows what you marked sensitive until Orbital closes, as a shake of the phone does.")
                Group("Orbital", footer = notes.joinToString("\n\n")) {
                    // the language notes are shown in, the same synced setting as Cmd+K Auto-translate … on the Mac
                    var open by remember { mutableStateOf(false) }
                    GroupRow(onClick = { open = true }) {
                        Label("language", "Auto-translate")
                        Box {
                            Text(engine.translator.to ?: "Off", color = c.secondary)
                            DropdownMenu(open, { open = false }) {
                                for (lang in listOf<String?>(null) + Translator.LANGUAGES) DropdownMenuItem({ Text(lang ?: "Off") }, { open = false; engine.scope.launch { engine.translate(lang) } })
                            }
                        }
                    }
                    OnOff("demo", "Demo mode", engine.demo) { engine.demo = it }
                    // what you marked sensitive, shown until Orbital closes, as a shake shows it: for a phone without the
                    // sensor, or a hand that cannot shake it
                    OnOff("visible", "Show sensitive items", engine.reveal) { engine.reveal = it }
                    GroupRow(last = true) { Label("info", "Version"); Text(engine.platform.version, color = c.secondary) }
                }
            }
            // signing out, apart from everything else and in red, as the ChatGPT app has its Log out
            item("out") {
                Group {
                    GroupRow(last = account == null, onClick = { close(); engine.scope.launch { engine.signOut() } }) { LogOut("Log out of Tana") }
                    if (account != null) GroupRow(last = true, onClick = { ai.forget(); account = null }) { LogOut("Log out of ChatGPT") }
                }
            }
        }
    }
}

// a row's glyph and words in the text colour: each account by its service's mark (Tana's, OpenAI's)
@Composable
private fun androidx.compose.foundation.layout.RowScope.Label(glyph: String, title: String) {
    val c = Theme.colors
    Glyph(glyph, Modifier.size(22.dp), c.text)
    Text(title, Modifier.weight(1f), color = c.text)
}

// a row that is a switch: the whole row flips it, and the switch in its own colour (in the rows' text colour it is white
// on white)
@Composable
private fun OnOff(glyph: String, title: String, on: Boolean, set: (Boolean) -> Unit) {
    val c = Theme.colors
    GroupRow(onClick = { set(!on) }) {
        Label(glyph, title)
        Switch(on, set, Modifier.semantics { contentDescription = title }, colors = SwitchDefaults.colors(checkedTrackColor = c.done, checkedThumbColor = Color.White, checkedBorderColor = c.done))
    }
}

@Composable
private fun LogOut(title: String) {
    val c = Theme.colors
    Icon(Icons.AutoMirrored.Outlined.Logout, null, tint = c.danger)
    Text(title, color = c.danger)
}

// Settings' Models: the Quick and the Regular AI, a segment each, the Mac Settings page's same synced choices
// (main/settings.js AI_KEYS) from the same remote list of models. A new model whose levels lack the effort takes low.
@Composable
fun Models(engine: Engine, models: List<ChatGPT.Model>, back: () -> Unit) {
    val c = Theme.colors
    var quick by remember { mutableStateOf(true) }
    val modelKey = if (quick) "quickModel" else "model"
    val effortKey = if (quick) "quickEffort" else "effort"
    val model = engine.translator.ai[modelKey] ?: ""
    val efforts = models.firstOrNull { it.id == model }?.levels ?: listOf("low", "medium", "high")
    SheetBar("Models", back = back)
    LazyColumn {
        item {
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                listOf(true to "Quick", false to "Regular").forEachIndexed { i, (q, label) ->
                    SegmentedButton(quick == q, { quick = q }, SegmentedButtonDefaults.itemShape(i, 2)) { Text(label) }
                }
            }
        }
        item {
            Group("Model", footer = if (quick) "For Auto-translate, Discuss with, types and icons: short questions, where a fast model is enough." else "For reading images in Quick Add and Share, where a bigger model reads better.") {
                models.forEachIndexed { i, m ->
                    GroupRow(last = i == models.size - 1, selected = m.id == model, onClick = {
                        engine.scope.launch {
                            engine.aiChoice(modelKey, m.id)
                            val next = m.levels
                            if (next.isNotEmpty() && engine.translator.ai[effortKey] !in next) engine.aiChoice(effortKey, if ("low" in next) "low" else next[0])
                        }
                    }) { Text(ChatGPT.label(m.id), Modifier.weight(1f), color = c.text); RadioButton(m.id == model, null) }
                }
            }
        }
        item {
            Group("Thinking", footer = "The same on your Mac.") {
                efforts.forEachIndexed { i, e ->
                    val on = (engine.translator.ai[effortKey] ?: "low") == e
                    GroupRow(last = i == efforts.size - 1, selected = on, onClick = { engine.scope.launch { engine.aiChoice(effortKey, e) } }) {
                        Text(ChatGPT.effortLabel(e), Modifier.weight(1f), color = c.text); RadioButton(on, null)
                    }
                }
            }
        }
    }
}
