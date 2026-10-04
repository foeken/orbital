// ios/Orbital/Agents.swift
package com.dreetje.orbital.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.dreetje.orbital.Agent
import com.dreetje.orbital.Engine
import com.dreetje.orbital.LinkCode
import com.dreetje.orbital.kindOf
import com.dreetje.orbital.maybe
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// Your Dot on the phone, as the Mac's Cmd+K has it (renderer/agent.js, main/agents/linked.js, ios/engine/agents.js):
// Settings' Agents, Connect to your OpenAI Dot with a one-time code, and Assign to <its name> … from a long press, with the
// request written here and the node's own words left in Tana. What is linked and handed over is in your settings
// document, so the Mac sees it too.

// what can be handed to an agent: a node of yours, not a chat, a search or a person
fun handable(id: String): Boolean = id.startsWith("tana:") && kindOf(id) !in listOf("chat", "search", "user-profile")

// Settings' Agents: each agent linked through orbital.md, by the name it gave itself, swiped right to make it the default
// and left to unlink it, then Connect to your OpenAI Dot
@Composable
fun AgentsGroup(engine: Engine, connect: () -> Unit) {
    val c = Theme.colors
    var problem by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { problem = engine.loadAgents() }
    val footer = listOfNotNull(problem, if (engine.agents.isEmpty())
        "Link your Dot, OpenAI's agent in ChatGPT, and hand it a task or a note with a long press. It reads the node in Tana itself." else null).joinToString("\n\n").ifEmpty { null }
    Group("Agents", footer = footer) {
        for (a in engine.agents) key(a.id) { AgentRow(engine, a) }
        GroupRow(last = true, onClick = connect) { Glyph("chatgpt", Modifier.size(22.dp), c.text); Text("Connect to your OpenAI Dot", Modifier.weight(1f), color = c.text) }
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

// Connect to your OpenAI Dot: both servers added in ChatGPT, then the message with a one-time code sent to your Dot. The page
// asks every two seconds whether the code was used and goes back once it was. Leaving it does not stop the code: a Dot that
// uses it later shows up all the same, as on the Mac.
@Composable
fun ConnectDot(engine: Engine, back: () -> Unit) {
    val c = Theme.colors
    var link by remember { mutableStateOf<LinkCode?>(null) }
    var state by remember { mutableStateOf("asking") } // asking, waiting, expired, failed, linked
    var failure by remember { mutableStateOf<String?>(null) }
    var linked by remember { mutableStateOf<String?>(null) } // "Echo · ChatGPT", once it is
    var copied by remember { mutableStateOf<String?>(null) } // what was copied last, said on its row for a moment
    var asks by remember { mutableIntStateOf(0) } // a new code asked for
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
    SheetBar("Connect to your OpenAI Dot", back = back)
    LazyColumn {
        item("add") {
            Group("Add both in ChatGPT", footer = "Add, then Create custom MCP server: a name and a URL each, the rest as it is.") {
                GroupRow(last = link == null, onClick = { engine.platform.open("https://chatgpt.com/plugins") }) { Glyph("chatgpt", Modifier.size(22.dp), c.text); Text("Open ChatGPT plugins", Modifier.weight(1f), color = c.text) }
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
            Group("Then ask your Dot to link", footer = "Send the message to your Dot in ChatGPT. The code works once, for fifteen minutes.\n\nOnly the node's id and your request go through orbital.md, and it keeps neither: the node's words stay in Tana, where your Dot reads them with its own Tana access.") {
                val l = link
                when {
                    state == "asking" -> GroupRow(last = true) { CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp); Text("Getting a code…", color = c.secondary) }
                    state == "failed" -> {
                        GroupRow { Text(failure ?: "No code", Modifier.weight(1f), color = c.secondary) }
                        GroupRow(last = true, onClick = { asks++ }) { Text("Try again", color = c.text) }
                    }
                    state == "linked" -> GroupRow(last = true) { Icon(Icons.Filled.CheckCircle, null, Modifier.size(20.dp), c.done); Text("Linked " + (linked ?: "your Dot"), color = c.done) }
                    l != null -> {
                        GroupRow(onClick = { copy("message", l.prompt) }) {
                            Icon(Icons.Outlined.ContentCopy, null, Modifier.size(20.dp), c.text); Text("Copy the message for your Dot", Modifier.weight(1f), color = c.text)
                            if (copied == "message") Text("Copied", color = c.secondary)
                        }
                        if (state == "expired" || l.expiresAt <= now) {
                            GroupRow { Text("The code expired. Nobody used it.", color = c.secondary) }
                            GroupRow(last = true, onClick = { asks++ }) { Text("Get a new code", color = c.text) }
                        } else {
                            GroupRow {
                                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                                Text("Waiting for your Dot to use the code…", Modifier.weight(1f), color = c.secondary)
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

// The request form in a sheet of its own: Ask again from a node's Agent field
@Composable
fun HandSheet(engine: Engine, handing: Engine.Handing, onDismiss: () -> Unit) {
    var held by remember { mutableStateOf(false) } // written in, or sending: no swipe throws it away
    Sheet(onDismiss, swipe = !held) { close -> HandForm(engine, handing, cancel = close, done = close) { held = it } }
}

// Your Dot picked in Assign to …, or asked again from a node's Agent field: what it should do with the node, written here
// and sent with the handoff; the node itself is only read, as content. Assign stays until the agent took it, and says why
// not when it did not (not listening yet, read-only). cancel or back leaves it, done closes whatever it was opened in;
// held says whether there is something written or on its way, which a swipe should not throw away.
@Composable
fun HandForm(engine: Engine, handing: Engine.Handing, cancel: (() -> Unit)? = null, back: (() -> Unit)? = null, done: () -> Unit, held: (Boolean) -> Unit = {}) {
    val c = Theme.colors
    val name = handing.agent.name
    var request by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(sending, request.isEmpty()) { held(sending || request.isNotEmpty()) }
    SheetBar("Assign to $name", cancel = cancel, back = back, action = "Assign", enabled = !sending && request.isNotBlank()) {
        sending = true; failure = null
        engine.scope.launch {
            try { engine.hand(handing.id, handing.agent, request); done(); handing.then() }
            catch (e: CancellationException) { throw e } catch (e: Exception) { failure = e.message }
            finally { sending = false }
        }
    }
    Group(footer = "$name reads the node in Tana. Only what you write here tells it what to do.") {
        OutlinedTextField(request, { request = it }, Modifier.fillMaxWidth().heightIn(min = 140.dp).focusRequester(focus), minLines = 4,
            placeholder = { Text("What should $name do?", color = c.secondary) }, shape = RoundedCornerShape(14.dp),
            colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = c.card, unfocusedContainerColor = c.card, focusedBorderColor = c.card, unfocusedBorderColor = c.card))
    }
    if (sending) Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) }
    failure?.let { Text(it, Modifier.padding(horizontal = 32.dp, vertical = 8.dp), color = c.danger) }
    LaunchedEffect(Unit) { maybe { focus.requestFocus() } }
}
