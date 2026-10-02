package com.dreetje.orbital.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.dreetje.orbital.Access
import com.dreetje.orbital.Engine
import com.dreetje.orbital.Member
import com.dreetje.orbital.names
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// A sheet over the page, as the iPhone's are: full height, the grouped background, closed by its own buttons, by a
// swipe down or by Back. content gets close, which slides it away first.
@Composable
fun Sheet(onDismiss: () -> Unit, content: @Composable ColumnScope.(close: () -> Unit) -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val close: () -> Unit = { scope.launch { state.hide() }.invokeOnCompletion { onDismiss() } }
    ModalBottomSheet(onDismiss, sheetState = state, containerColor = Theme.colors.grouped, dragHandle = null, contentWindowInsets = { WindowInsets.statusBars }) {
        Column(Modifier.fillMaxWidth().fillMaxHeight()) { content(close) }
    }
}

// A sheet's bar: what leaves it on the left (Cancel, or Back on a page inside it), its title, what it does on the right
@Composable
fun SheetBar(title: String, cancel: (() -> Unit)? = null, back: (() -> Unit)? = null, action: String? = null, enabled: Boolean = true, onAction: () -> Unit = {}) {
    val c = Theme.colors
    Box(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 4.dp)) {
        Row(Modifier.align(Alignment.CenterStart)) {
            if (back != null) IconButton(back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = c.text) }
            else if (cancel != null) TextButton(cancel) { Text("Cancel", color = c.text) }
        }
        Text(title, Modifier.align(Alignment.Center).padding(horizontal = 96.dp).semantics { heading() }, style = Type.headline, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
        if (action != null) TextButton(onAction, Modifier.align(Alignment.CenterEnd), enabled = enabled) {
            Text(action, fontWeight = FontWeight.SemiBold, color = if (enabled) c.text else c.tertiary)
        }
    }
}

// Rows in a rounded group under a grey heading, a line under the group's words, as the iPhone's Form sections
@Composable
fun Group(header: String? = null, footer: String? = null, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val c = Theme.colors
    Column(modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        if (header != null) Text(header, Modifier.padding(start = 16.dp, bottom = 6.dp).semantics { heading() }, style = Type.headline, color = c.secondary)
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.card), content = content)
        if (footer != null) Text(footer, Modifier.padding(start = 16.dp, end = 16.dp, top = 6.dp), style = Type.footnote, color = c.secondary)
    }
}

// One row of a group: its words and its value; a line under it unless it is the last
@Composable
fun GroupRow(modifier: Modifier = Modifier, last: Boolean = false, onClick: (() -> Unit)? = null, selected: Boolean? = null, content: @Composable RowScope.() -> Unit) {
    val c = Theme.colors
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth()
                .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
                .then(if (selected != null) Modifier.semantics { this.selected = selected } else Modifier)
                .heightIn(min = 50.dp).padding(horizontal = 16.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically, content = content,
        )
        if (!last) HorizontalDivider(Modifier.padding(start = 16.dp), color = c.separator)
    }
}

@Composable
fun Tick(on: Boolean) {
    if (on) Icon(Icons.Filled.Check, null, Modifier.size(20.dp), Theme.colors.text) else Spacer(Modifier.width(20.dp))
}

@Composable
fun SearchField(query: String, set: (String) -> Unit, modifier: Modifier = Modifier) {
    val c = Theme.colors
    OutlinedTextField(query, set, modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), singleLine = true,
        placeholder = { Text("Search", color = c.secondary) }, leadingIcon = { Icon(Icons.Outlined.Search, null, tint = c.secondary) },
        shape = RoundedCornerShape(12.dp),
        colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = c.card, unfocusedContainerColor = c.card, focusedBorderColor = c.separator, unfocusedBorderColor = c.separator))
}

// A person or a node to pick, searchable: Assign to, Quick Add's person and link fields. none is the row that leaves it
// unset. The list is asked again as you type, once typing pauses.
@Composable
fun Choices(title: String, none: String, load: suspend (String) -> List<Member>, current: (String?) -> Boolean = { false }, back: (() -> Unit)? = null, cancel: (() -> Unit)? = null, pick: (Member?) -> Unit) {
    var query by remember { mutableStateOf("") }
    var items by remember { mutableStateOf(listOf<Member>()) }
    var loaded by remember { mutableStateOf(false) }
    LaunchedEffect(query) {
        if (query.isNotEmpty()) delay(250)
        items = load(query) // typed on meanwhile: this one is cancelled, the newer answer wins
        loaded = true
    }
    SheetBar(title, cancel = cancel, back = back)
    SearchField(query, { query = it })
    if (loaded && items.isEmpty() && query.isNotEmpty()) { Empty("No results", "Nothing matches “$query”.", icon = Icons.Outlined.Search); return }
    LazyColumn(Modifier.fillMaxWidth()) {
        item { Spacer(Modifier.padding(top = 4.dp)) }
        if (query.isEmpty()) item("none") { Group { GroupRow(last = true, onClick = { pick(null) }, selected = current(null)) { Text(none, Modifier.weight(1f), color = Theme.colors.text); Tick(current(null)) } } }
        item("all") {
            if (items.isNotEmpty()) Group {
                items.forEachIndexed { i, m -> GroupRow(last = i == items.size - 1, onClick = { pick(m) }, selected = current(m.id)) { Text(m.name, Modifier.weight(1f), color = Theme.colors.text); Tick(current(m.id)) } }
            }
        }
    }
}

// Long press, Assign to …: the workspace's people, searchable, the task's assignee ticked; a pick gives the task to that
// person alone, as the desktop's Assign to … does, and Unassigned takes everyone off it
@Composable
fun AssignSheet(engine: Engine, task: Engine.Assigning, onDismiss: () -> Unit) {
    var people by remember { mutableStateOf<List<Member>?>(null) }
    Sheet(onDismiss) { close ->
        Choices("Assign to", "Unassigned", { q ->
            val all = people ?: engine.members().sortedBy { it.name.lowercase() }.also { people = it }
            if (q.isEmpty()) all else all.filter { it.name.contains(q, ignoreCase = true) }
        }, current = { uri -> task.current?.let { now -> if (uri != null) now == listOf(uri) else now.isEmpty() } ?: false }, cancel = close) { m ->
            close()
            engine.scope.launch { engine.assign(task.id, m?.id, task.then); task.then() }
        }
    }
}

// renderer/tasks.js AUDIENCES: the scope's glyph and its word, a space by its name
@Composable
fun AudienceLabel(scope: String, space: String?, glyphs: Boolean = true) {
    val c = Theme.colors
    val (word, glyph) = when (scope) {
        "only-me" -> "Only you" to "lock"
        "people" -> "Selected people" to "userLock"
        "space" -> (space?.let { "Members of $it" } ?: "Space members") to "houseLock"
        "everyone" -> "Everyone" to "users"
        else -> "Unknown" to "hidden"
    }
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        if (glyphs) Glyph(glyph, Modifier.size(18.dp), c.secondary)
        Text(word, style = Type.body, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// Who can see a document (renderer/access.js visibilityRows): only you, the people picked, or whoever sees where it
// lives, the rule it is shared by now ticked, who that is listed, and why not when you may not change it
@Composable
fun VisibilitySheet(id: String, access: Access, engine: Engine, done: suspend () -> Unit, onDismiss: () -> Unit) {
    val c = Theme.colors
    var picking by remember { mutableStateOf(false) }
    Sheet(onDismiss) { close ->
        if (picking) { PeoplePicker(access, engine, back = { picking = false }) { uris -> close(); engine.scope.launch { engine.share(id, "people", uris); done() } }; return@Sheet }
        SheetBar("Visibility", cancel = close)
        LazyColumn {
            item {
                Group(footer = access.reason) {
                    val rules = listOfNotNull("me".takeIf { it in access.rules }, "people".takeIf { it in access.rules }, "inherit".takeIf { it in access.rules })
                    rules.forEachIndexed { i, rule ->
                        val (title, glyph) = when (rule) { "me" -> "Only me" to "lock"; "people" -> "Selected people …" to "userLock"; else -> "Inherit" to "houseLock" }
                        GroupRow(last = i == rules.size - 1, selected = access.rule == rule, onClick = {
                            if (rule == "people") picking = true
                            else { close(); engine.scope.launch { engine.share(id, rule, token = access.token); done() } }
                        }) {
                            Glyph(glyph, Modifier.size(20.dp), c.text)
                            Text(title, Modifier.weight(1f), color = c.text)
                            if (rule == "inherit") AudienceLabel(access.inherit.scope, access.inherit.space, glyphs = false)
                            Tick(access.rule == rule)
                        }
                    }
                }
            }
            if (access.people.isNotEmpty()) item {
                Group("Who can see it") { access.people.forEachIndexed { i, p -> GroupRow(last = i == access.people.size - 1) { Text(p.name, color = c.text) } } }
            }
        }
    }
}

// Selected people …: the workspace's people, those who can see it now first and ticked, applied together
@Composable
fun PeoplePicker(access: Access, engine: Engine, back: () -> Unit, apply: (List<String>) -> Unit) {
    val c = Theme.colors
    var people by remember { mutableStateOf(listOf<Member>()) }
    var picked by remember { mutableStateOf(access.participants.toSet()) }
    var query by remember { mutableStateOf("") }
    LaunchedEffect(Unit) {
        val seeing = access.participants.toSet()
        people = engine.members().filter { it.id != access.me }.sortedWith(compareBy<Member> { it.id !in seeing }.thenBy { it.name.lowercase() })
    }
    SheetBar("Select people", back = back, action = "Apply", enabled = picked.isNotEmpty()) { apply(picked.toList()) }
    SearchField(query, { query = it })
    val shown = people.filter { query.isEmpty() || it.name.contains(query, ignoreCase = true) }
    LazyColumn {
        item {
            if (shown.isNotEmpty()) Group {
                shown.forEachIndexed { i, p ->
                    val on = p.id in picked
                    GroupRow(last = i == shown.size - 1, selected = on, onClick = { picked = if (on) picked - p.id else picked + p.id }) {
                        Text(p.name, Modifier.weight(1f), color = c.text); Tick(on)
                    }
                }
            }
        }
    }
}

// Assigned someone who cannot open it (Engine.assign): Grant access shares it with them, Keep private leaves it as it is
@Composable
fun ShareAskDialog(engine: Engine) {
    val ask = engine.asking ?: return
    AlertDialog(
        onDismissRequest = { engine.asking = null },
        title = { Text(ask.shut.names + " can’t see this") },
        text = {
            Text("“" + ask.access.title + "” is assigned to " + ask.shut.names + ", but they won’t be able to open it unless you grant access or move it somewhere they can see." +
                if (ask.access.grants) "" else " It is shared through where it lives, so share that instead.")
        },
        confirmButton = {
            if (ask.access.grants) TextButton({
                engine.asking = null
                engine.scope.launch { engine.share(ask.id, "people", ask.access.participants + ask.shut.map { it.id }); ask.then() }
            }) { Text("Grant access") }
        },
        dismissButton = { TextButton({ engine.asking = null }) { Text("Keep private") } },
    )
}

fun Modifier.button() = semantics { role = Role.Button }
