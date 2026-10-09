// ios/Orbital/Agents.swift
package com.dreetje.orbital.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.dreetje.orbital.Agent
import com.dreetje.orbital.Dictation
import com.dreetje.orbital.Engine
import com.dreetje.orbital.LinkCode
import com.dreetje.orbital.kindOf
import com.dreetje.orbital.maybe
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// Your personal agent on the phone (your OpenAI Dot, or any agent that speaks MCP), as the Mac's Cmd+K has it
// (renderer/agent.js, main/agents/linked.js, ios/engine/agents.js): Settings' Agents, Connect your personal agent with a
// one-time code, and Assign to <its name> … from a long press, with the
// request written here and the node's own words left in Tana. What is linked and handed over is in your settings
// document, so the Mac sees it too.

// what can be handed to an agent: a node of yours, not a chat, a search or a person
fun handable(id: String): Boolean = id.startsWith("tana:") && kindOf(id) !in listOf("chat", "search", "user-profile")

// Settings' Agents: each agent linked through orbital.md, by the name it gave itself, swiped right to make it the default
// and left to unlink it, then Connect your personal agent
@Composable
fun AgentsGroup(engine: Engine, connect: () -> Unit) {
    val c = Theme.colors
    var problem by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { problem = engine.loadAgents() }
    val footer = listOfNotNull(problem, if (engine.agents.isEmpty())
        "Link your personal agent, like your OpenAI Dot, and hand it a task or a note with a long press. It reads the node in Tana itself." else null).joinToString("\n\n").ifEmpty { null }
    Group("Agents", footer = footer) {
        for (a in engine.agents) key(a.id) { AgentRow(engine, a) }
        GroupRow(last = true, onClick = connect) { Glyph("mcp", Modifier.size(22.dp), c.text); Text("Connect your personal agent", Modifier.weight(1f), color = c.text) }
    }
}

// One linked agent: right to make it the default (not on the default itself), left to unlink it, each word on its colour
// under the row as it moves, as the iPhone's swipe actions
@Composable
private fun AgentRow(engine: Engine, a: Agent) {
    val c = Theme.colors
    val state = rememberSwipeToDismissBoxState()
    val scope = rememberCoroutineScope()
    SwipeToDismissBox(state, backgroundContent = {
        val toDefault = state.dismissDirection == SwipeToDismissBoxValue.StartToEnd
        Row(Modifier.fillMaxSize().background(if (toDefault) c.accent else c.danger).padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = if (toDefault) Arrangement.Start else Arrangement.End) { Text(if (toDefault) "Make Default" else "Unlink", color = Color.White) }
    }, enableDismissFromStartToEnd = !a.isDefault, onDismiss = { way ->
        engine.scope.launch { if (way == SwipeToDismissBoxValue.StartToEnd) engine.makeDefault(a) else engine.unlink(a) }
        scope.launch { state.reset() }
    }) {
        GroupRow(Modifier.background(c.card)) {
            Glyph("robot", Modifier.size(22.dp), c.text)
            Text(a.name, Modifier.weight(1f), color = c.text)
            Text(listOf(if (a.isDefault) "Default" else "", if (a.on) "" else "Off").filter { it.isNotEmpty() }.joinToString(" · "), color = c.secondary, maxLines = 1)
        }
    }
}

// Connect your personal agent: both plugins (MCP servers) added to your agent, then the instructions with a one-time code
// sent to it. The ? beside the plugins opens ConnectHelp: your OpenAI Dot step by step, then any other agent. The page
// asks every two seconds whether the code was used and goes back once it was. Leaving it does not stop the code: an agent
// that uses it later shows up all the same, as on the Mac.
@Composable
fun ConnectAgent(engine: Engine, back: () -> Unit) {
    val c = Theme.colors
    var link by remember { mutableStateOf<LinkCode?>(null) }
    var state by remember { mutableStateOf("asking") } // asking, waiting, expired, failed, linked
    var failure by remember { mutableStateOf<String?>(null) }
    var linked by remember { mutableStateOf<String?>(null) } // "Echo · ChatGPT", once it is
    var copied by remember { mutableStateOf<String?>(null) } // what was copied last, said on its row for a moment
    var asks by remember { mutableIntStateOf(0) } // a new code asked for
    var help by remember { mutableStateOf(false) }
    var now by remember { mutableStateOf(engine.now().toEpochMilliseconds()) }
    LaunchedEffect(asks) {
        state = "asking"; failure = null
        try { link = engine.linkCode(); state = "waiting" } catch (e: CancellationException) { throw e } catch (e: Exception) { failure = e.message; state = "failed" }
    }
    LaunchedEffect(link?.code) {
        val code = link?.code ?: return@LaunchedEffect
        while (state == "waiting") {
            delay(2000)
            val s = maybe { engine.linkStatus(code) } ?: continue // a missed answer: the next one asks again
            val a = s.agent
            if (s.state == "linked" && a != null) {
                linked = a.name
                state = "linked"
                engine.loadAgents()
                delay(1200)
                back()
            } else if (s.state != "waiting") state = s.state
        }
    }
    LaunchedEffect(state) { while (state == "waiting") { now = engine.now().toEpochMilliseconds(); delay(1000) } }
    LaunchedEffect(copied) { if (copied != null) { delay(2000); copied = null } }
    val copy = { name: String, text: String -> engine.platform.copy(text); copied = name }
    if (help) { ConnectHelp(engine, link) { help = false }; return }
    SheetBar("Connect your personal agent", back = back)
    LazyColumn {
        item("add") {
            Group("Add both plugins", footer = "Add each to your agent as a custom MCP server, a name and a URL. A tap copies the URL.", help = { help = true }) {
                link?.let { l ->
                    // a server as ChatGPT's form asks for it, a name and a URL: a tap copies the URL
                    for ((i, server) in listOf(Triple("Orbital", l.url, "robot"), Triple("Tana", l.tana, "tana")).withIndex()) {
                        val (name, url, glyph) = server
                        GroupRow(last = i == 1, onClick = { copy(name, url) }) {
                            Glyph(glyph, Modifier.size(22.dp), c.text); Text(name, color = c.text)
                            Text(if (copied == name) "Copied" else url.removePrefix("https://"), Modifier.weight(1f), color = c.secondary, maxLines = 1, textAlign = TextAlign.End)
                        }
                    }
                }
            }
        }
        item("link") {
            Group("Then ask your agent to link", footer = "Send the instructions to your agent. The code works once, for fifteen minutes.\n\nOnly the node's id and your request go through ${(link?.url ?: "https://orbital.md/mcp").removePrefix("https://")}, and it keeps neither: the node's words stay in Tana, where your agent reads them with its own Tana access.") {
                val l = link
                when {
                    state == "asking" -> GroupRow(last = true) { CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp); Text("Getting a code…", color = c.secondary) }
                    state == "failed" -> {
                        GroupRow { Text(failure ?: "No code", Modifier.weight(1f), color = c.secondary) }
                        GroupRow(last = true, onClick = { asks++ }) { Text("Try again", color = c.text) }
                    }
                    state == "linked" -> GroupRow(last = true) { Icon(Icons.Filled.CheckCircle, null, Modifier.size(20.dp), c.done); Text("Linked " + (linked ?: "your agent"), color = c.done) }
                    l != null -> {
                        GroupRow(onClick = { copy("message", l.prompt) }) {
                            Icon(Icons.Outlined.ContentCopy, null, Modifier.size(20.dp), c.text); Text("Copy the instructions", Modifier.weight(1f), color = c.text)
                            if (copied == "message") Text("Copied", color = c.secondary)
                        }
                        if (state == "expired" || l.expiresAt <= now) {
                            GroupRow { Text("The code expired. Nobody used it.", color = c.secondary) }
                            GroupRow(last = true, onClick = { asks++ }) { Text("Get a new code", color = c.text) }
                        } else {
                            GroupRow {
                                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                                Text("Waiting for your agent to use the code…", Modifier.weight(1f), color = c.secondary)
                                Text(left(l.expiresAt, now), color = c.secondary)
                            }
                            // a glyph's column, as the rows above, so the words line up
                            GroupRow(last = true, onClick = { engine.scope.launch { engine.linkCancel(l.code) }; back() }) { Icon(Icons.Outlined.Close, null, Modifier.size(20.dp), c.danger); Text("Cancel", color = c.danger) }
                        }
                    }
                }
            }
        }
    }
}

// minutes and seconds until the code runs out
private fun left(expiresAt: Double, now: Long): String {
    val s = maxOf(0L, ((expiresAt - now) / 1000).toLong())
    return (s / 60).toString() + ":" + (s % 60).toString().padStart(2, '0')
}

// The ? beside Add both plugins: your OpenAI Dot step by step, with ChatGPT's plugins a tap away, then the same for any
// other agent that can add MCP servers and hear MCP events
@Composable
private fun ConnectHelp(engine: Engine, link: LinkCode?, back: () -> Unit) {
    val c = Theme.colors
    val orbital = (link?.url ?: "https://orbital.md/mcp").removePrefix("https://")
    val tana = (link?.tana ?: "https://home.tana.inc/mcp").removePrefix("https://")
    SheetBar("Adding the plugins", back = back)
    LazyColumn {
        item("dot") {
            Group("Your OpenAI Dot", footer = "Your Dot links itself with the code, and the page says Linked. The code works once, for fifteen minutes.") {
                GroupRow(onClick = { engine.platform.open("https://chatgpt.com/plugins") }) { Glyph("chatgpt", Modifier.size(22.dp), c.text); Text("Open ChatGPT plugins", Modifier.weight(1f), color = c.text) }
                Step(1, "Open ChatGPT plugins, tap **Add**, then **Create custom MCP server**.")
                Step(2, "Name it **Orbital**, with the URL $orbital. Leave the rest as it is: ChatGPT signs in to Orbital by itself.")
                Step(3, "Add a second one named **Tana**, with the URL $tana, and sign in with your Tana account when it asks.")
                Step(4, "Come back, tap **Copy the instructions** and send them to your Dot in ChatGPT.", last = true)
            }
        }
        item("other") {
            Group("Any other agent", footer = "Your agent needs support for MCP events: that is how it hears about the tasks you hand it.") {
                Step(1, "Add **Orbital** to your agent as an MCP server, with the URL $orbital.")
                Step(2, "Add **Tana** as an MCP server too, with the URL $tana, signed in with your Tana account.")
                Step(3, "Tap **Copy the instructions** and send them to your agent.", last = true)
            }
        }
    }
}

// one numbered step, its number in a ring where the rows above have their glyph, as the iPhone's 1.circle
@Composable
private fun Step(n: Int, words: String, last: Boolean = false) {
    val c = Theme.colors
    GroupRow(last = last) {
        Box(Modifier.size(22.dp).border(1.dp, c.text, CircleShape), contentAlignment = Alignment.Center) { Text(n.toString(), style = Type.footnote, color = c.text) }
        Text(bolded(words), Modifier.weight(1f), color = c.text)
    }
}

// **words** in bold, as the iPhone's Markdown draws them
private fun bolded(words: String) = buildAnnotatedString {
    words.split("**").forEachIndexed { i, part -> if (i % 2 == 1) withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(part) } else append(part) }
}

// The request form in a sheet of its own: Ask again from a node's Agent field
@Composable
fun HandSheet(engine: Engine, handing: Engine.Handing, onDismiss: () -> Unit) {
    var held by remember { mutableStateOf(false) } // written in, or dictating: no swipe throws it away
    Sheet(onDismiss, swipe = !held) { close -> HandForm(engine, handing, cancel = close, done = close) { held = it } }
}

// Your agent picked in Assign to …, or asked again from a node's Agent field: what it should do with the node, written or
// dictated here (as Quick Add's title is) and sent with the handoff; the node itself is only read, as content. Assign
// closes it at once and the handoff goes on behind it, the + turning meanwhile (Engine.handOff); a request the agent did
// not take is said and kept, and opens here again. cancel or back leaves it, done closes whatever it was opened in;
// held says whether there is something written or being dictated, which a swipe should not throw away.
@Composable
fun HandForm(engine: Engine, handing: Engine.Handing, cancel: (() -> Unit)? = null, back: (() -> Unit)? = null, done: () -> Unit, held: (Boolean) -> Unit = {}) {
    val c = Theme.colors
    val name = handing.agent.name
    var request by remember { mutableStateOf(engine.unhanded[handing.id] ?: "") } // not taken last time: written again
    val dictation = remember { Dictation(engine.platform, engine.scope) }
    DisposableEffect(Unit) { onDispose { dictation.cancel() } } // closed while listening: the microphone stops
    val busy = dictation.busy
    val focus = remember { FocusRequester() }
    LaunchedEffect(busy, request.isEmpty()) { held(busy || request.isNotEmpty()) }
    // dictated words land after what the request already says
    fun append(said: String) { request = Dictation.join(request, said) }
    // Assign closes the form at once and the handoff goes on behind it (Engine.handOff); pressed while dictating, the words
    // are waited for first, and one whose words did not come is not sent
    SheetBar("Assign to $name", cancel = cancel, back = back, action = "Assign", enabled = !dictation.settling && (request.isNotBlank() || busy)) {
        engine.scope.launch {
            if (!dictation.settled(::append)) return@launch
            val words = request.trim()
            if (words.isEmpty()) return@launch
            engine.handOff(handing, words)
            done()
        }
    }
    Group(footer = listOfNotNull(dictation.problem, "$name reads the node in Tana. Only what you write here tells it what to do.").joinToString("\n\n")) {
        // the request, and dictating it: the microphone starts listening; while it listens, ✕ throws the recording away and
        // ■ stops it, its words then added to the request
        Row(Modifier.fillMaxWidth().padding(end = 8.dp, top = 8.dp), verticalAlignment = Alignment.Top) {
            if (!dictation.recording) OutlinedTextField(request, { request = it }, Modifier.weight(1f).heightIn(min = 140.dp).focusRequester(focus), minLines = 4,
                placeholder = { Text("What should $name do?", color = c.secondary) }, shape = RoundedCornerShape(14.dp),
                colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = c.card, unfocusedContainerColor = c.card, focusedBorderColor = c.card, unfocusedBorderColor = c.card))
            Dictate(dictation, engine, ::append)
        }
    }
    LaunchedEffect(Unit) { maybe { focus.requestFocus() } }
}
