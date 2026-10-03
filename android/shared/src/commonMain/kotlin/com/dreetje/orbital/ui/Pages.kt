package com.dreetje.orbital.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.dreetje.orbital.Access
import com.dreetje.orbital.Engine
import com.dreetje.orbital.Failure
import com.dreetje.orbital.Lists
import com.dreetje.orbital.Member
import com.dreetje.orbital.Row as Node
import com.dreetje.orbital.Times
import com.dreetje.orbital.kindOf
import com.dreetje.orbital.names
import com.dreetje.orbital.parseTime
import com.dreetje.orbital.persons
import kotlin.time.Instant
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// The iPhone's ios/Orbital/Pages.swift: a node zoomed into (an outline, a saved search, a meeting, a chat) and who
// has it and who sees it

// Zoomed into a node: a chat as its conversation, a saved search as its results, a meeting as the documents it owns,
// anything else as its outline. A mention, a reference or a row opens the node it names.
@Composable
fun NodeScreen(
    engine: Engine,
    id: String,
    modifier: Modifier = Modifier,
    titled: Boolean = true, // false when the page is the menu's own and the shell names it
    note: String? = null, // what the composer that started this chat had to say (Tana did not answer, or saved for later)
    asked: Instant? = null, // when the message that opened this chat was sent: its answer is waited for
    onBack: (() -> Unit)? = null,
) {
    val c = Theme.colors
    val scope = rememberCoroutineScope()
    var page by remember(id) { mutableStateOf(engine.cached(id)) } // back to a page: the last read of it at once, as NavigationStack keeps it
    var error by remember(id) { mutableStateOf<String?>(null) }
    var waitingSince by remember(id) { mutableStateOf<Instant?>(null) }
    var access by remember(id) { mutableStateOf<Access?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var assigningVisibility by remember { mutableStateOf(false) }

    // A read keeps what is on screen when it fails, and says why only while there is nothing to show
    suspend fun load() {
        try { page = engine.open(id); error = null } catch (e: Failure) { error = e.message }
        val kind = page?.kind
        if (kind != null && kind !in listOf("chat", "search", "event")) access = engine.access(id) ?: access
    }

    LaunchedEffect(engine.phase, id) {
        if (engine.phase != Engine.Phase.Ready) return@LaunchedEffect
        load()
        // A chat is read again every two seconds while it is on screen, so Tana's answer shows as it is written: the
        // document is live in the engine, so this is a local read, not a request.
        // ponytail: polled; have the engine call back on the chat's changes if this ever costs.
        while ((page?.kind ?: kindOf(id)) == "chat") { delay(2000); load() }
    }
    LaunchedEffect(engine.sensitiveIds) { if (page != null) load() } // marked or unmarked on another device: drawn again
    val refresh: () -> Unit = { scope.launch { refreshing = true; load(); refreshing = false } }

    val current = page
    val hiddenPage = current?.sensitive == true && !engine.reveal
    Column(modifier.fillMaxSize()) {
        if (titled) PageBar(if (hiddenPage) "" else engine.translator.words(current?.title ?: "", current?.sensitive == true).first, onBack = onBack)
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                current != null && hiddenPage -> Empty("Hidden", "You marked this sensitive in Orbital. Shake your phone to show sensitive items, and shake it again to hide them.", glyph = "hidden")
                current != null -> when (current.kind) {
                    "chat" -> Column(Modifier.fillMaxSize()) {
                        ChatView(current.rows, waitingSince ?: asked, engine, Modifier.weight(1f))
                        // sent is sent: the read after it is the next poll's job, so a failed read never offers to send it twice
                        Composer(engine, "Follow up", note) { text -> val sent = engine.send(text, id); waitingSince = engine.now(); load(); sent.warning }
                    }
                    "search", "event" -> PullToRefreshBox(refreshing, refresh, Modifier.fillMaxSize()) {
                        val rows = engine.shown(current.rows)
                        // in the sections the search was saved with (Row.group), as the desktop shows it
                        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 6.dp)) {
                            val key = uniqueKeys()
                            Lists.sections(rows).forEachIndexed { s, (title, list) ->
                                if (title != null) item("h$s") { Text(title, Modifier.padding(start = 16.dp, top = 14.dp, bottom = 4.dp).semantics { heading() }, style = Type.headline, color = c.secondary) }
                                list.forEach { row -> item(key("row:" + row.id)) { ListRow(row, engine) { load() } } }
                            }
                        }
                        if (current.rows.isEmpty()) Empty(if (current.kind == "event") "No notes yet" else "Nothing found", glyph = Glyphs.of(current.kind))
                    }
                    else -> PullToRefreshBox(refreshing, refresh, Modifier.fillMaxSize()) {
                        val flat = Lists.flat(current.rows)
                        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 8.dp)) {
                            val key = uniqueKeys()
                            access?.let { a -> item("details") { NodeDetails(id, a, engine, open = { assigningVisibility = true }) { load() } } }
                            flat.forEach { (row, depth) -> item(key("block:" + row.id)) { OutlineRow(row, depth, engine.reveal) } }
                        }
                        // a document with fields shows them alone
                        if (flat.isEmpty() && access == null) Empty("Nothing in here yet", glyph = "doc")
                    }
                }
                error != null -> Empty("Didn't open", error, icon = Icons.Outlined.ErrorOutline) { OutlinedButton({ scope.launch { load() } }) { Text("Try again") } }
                else -> CircularProgressIndicator(Modifier.align(Alignment.Center), color = c.secondary)
            }
        }
    }
    val a = access
    if (assigningVisibility && a != null) VisibilitySheet(id, a, engine, done = { load() }) { assigningVisibility = false }
}

// One node in a list: a task's box or its kind's glyph, then its words and when it last changed, which open it. The box
// is its own button beside it, so ticking a task never opens it too.
@Composable
fun ListRow(row: Node, engine: Engine, reload: suspend () -> Unit) {
    val c = Theme.colors
    val zoom = LocalZoom.current
    val hidden = row.sensitive == true && !engine.reveal
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        if (row.stateType != null) TaskBox(row, engine, onBaseline(4.dp))
        else Glyph(Glyphs.of(row.icon), onBaseline(4.dp, Modifier.size(20.dp)), c.secondary)
        NodeMenu(row.target, engine, Modifier.weight(1f).alignByBaseline(), task = if (row.stateType != null) engine.state(row) else null, assignees = row.assignees, then = reload, onClick = { zoom(row.target) }) {
            Column(Modifier.fillMaxWidth().padding(vertical = 9.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                val (words, from) = engine.translator.words(row.words, row.sensitive == true)
                if (row.stateType != null) TaskWords(row, engine, globe = false) else Sensitive(hidden) { Words(words) }
                // translated, when it changed, who has it: one grey line as the desktop's subtext, a dot between each
                val at = row.createdAt?.let(::parseTime)
                val people = row.people ?: emptyList()
                if (from != null || at != null || people.isNotEmpty()) Sensitive(hidden) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (from != null) Glyph("language", Modifier.size(15.dp), c.secondary, "Translated from $from")
                        if (from != null && at != null) Text("·", color = c.secondary)
                        if (at != null) Words(Times.relative(at, engine.now()), style = Type.subheadline, color = c.secondary, maxLines = 1)
                        if ((from != null || at != null) && people.isNotEmpty()) Text("·", color = c.secondary)
                        if (people.isNotEmpty()) Faces(people)
                    }
                }
            }
        }
    }
}

// One block of an outline: a bullet and its words, indented by depth; a heading bigger and with no bullet; a reference
// its node's glyph and name, which opens it
@Composable
fun OutlineRow(row: Node, depth: Int, reveal: Boolean) {
    val c = Theme.colors
    val zoom = LocalZoom.current
    val density = LocalDensity.current
    val ref = row.reference
    val style = when (row.heading) { null -> Type.body; 1 -> Type.title2; 2 -> Type.title3; else -> Type.headline }
    Row(
        Modifier.fillMaxWidth()
            .then(if (ref != null) Modifier.clickable { zoom(ref.uri) }.semantics { role = Role.Button } else Modifier)
            .padding(start = 16.dp + 22.dp * depth, end = 16.dp, top = if (row.heading != null) 14.dp else 5.dp, bottom = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (row.heading == null) {
            if (ref != null) Glyph(Glyphs.ofUri(ref.uri), onBaseline(3.5.dp, Modifier.size(18.dp)), c.secondary)
            // centred on the lower-case letters
            else Box(onBaseline((-2.5).dp, Modifier.width(18.dp).height(6.dp)), contentAlignment = Alignment.Center) {
                Box(Modifier.size(6.dp).background(c.tertiary, CircleShape))
            }
        }
        Sensitive(row, reveal, Modifier.weight(1f).alignByBaseline()) {
            if (row.type == "image" || row.type == "table") Text(if (row.type == "image") "Image" else "Table", style = style, color = c.secondary)
            else Words(row.styled(c, zoom), style = style, modifier = if (row.heading != null) Modifier.semantics { heading() } else Modifier)
        }
    }
}

// A chat as the desktop draws one (renderer/chat.js, styles.css .chat-msg): your messages in a blue bubble on the right,
// everyone else's as plain text across the page with their name over each run of them, what Tana did while thinking
// in grey over a hairline, and three dots while an answer is on its way (since: when the last message was sent).
// A short conversation sits at the bottom, over the composer, as the iPhone's .defaultScrollAnchor(.bottom) has it.
@Composable
fun ChatView(rows: List<Node>, since: Instant?, engine: Engine, modifier: Modifier = Modifier) {
    val list = rememberLazyListState()
    val waiting = Lists.waiting(rows, since, engine.now())
    LaunchedEffect(rows.size, waiting) { if (rows.isNotEmpty()) list.scrollToItem(rows.size - 1 + if (waiting) 1 else 0) }
    val keys = remember(rows) { val key = uniqueKeys(); rows.map { key(it.id) } }
    LazyColumn(modifier.fillMaxWidth(), list, PaddingValues(horizontal = 20.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(24.dp, Alignment.Bottom)) {
        itemsIndexed(rows, key = { i, _ -> keys[i] }) { i, row ->
            Sensitive(row, engine.reveal) { Message(row, Lists.named(row, rows.getOrNull(i - 1)), engine.reveal) }
        }
        if (waiting) item("dots") { Dots(engine.platform.reduceMotion) }
    }
}

@Composable
fun Message(row: Node, named: Boolean, reveal: Boolean) {
    val c = Theme.colors
    val blocks = row.children ?: emptyList()
    when {
        row.chat?.status == true -> Text(row.words, Modifier.fillMaxWidth(), style = Type.footnote, color = c.secondary, textAlign = TextAlign.Center)
        row.chat?.mine == true -> Box(Modifier.fillMaxWidth().padding(start = 56.dp), contentAlignment = Alignment.CenterEnd) {
            Column(Modifier.background(c.bubble, RoundedCornerShape(16.dp)).padding(horizontal = 16.dp, vertical = 11.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (b in blocks) Sensitive(b, reveal) { ChatBlock(b, c.bubbleText) }
            }
        }
        else -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (named) Text(row.words, style = Type.subheadline.copy(fontWeight = FontWeight.SemiBold), color = c.text)
            for (b in blocks) Sensitive(b, reveal) { ChatBlock(b, c.text) }
        }
    }
}

// One block of a message: a line of what it did (grey), a document (its glyph and name, opens it), code, or words
@Composable
fun ChatBlock(row: Node, color: androidx.compose.ui.graphics.Color) {
    val c = Theme.colors
    val zoom = LocalZoom.current
    val ref = row.reference
    when {
        row.note == true -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) { Words(row.words, style = Type.subheadline, color = c.secondary); HorizontalDivider(color = c.separator) }
        ref != null -> Row(Modifier.clip(CircleShape).background(c.fill).clickable { zoom(ref.uri) }.semantics { role = Role.Button }.padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Glyph(Glyphs.ofUri(ref.uri), Modifier.size(18.dp), color)
            Words(row.words, color = color, maxLines = 1)
        }
        row.block == "divider" -> HorizontalDivider(color = c.separator)
        row.block == "bullet" || row.block == "numbered" -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { Text("•", color = c.secondary); Words(row.styled(c, zoom), color = color) }
        row.block == "code" -> Text(row.words, Modifier.fillMaxWidth().background(c.fillQuiet, RoundedCornerShape(12.dp)).padding(12.dp), style = Type.subheadline.copy(fontFamily = FontFamily.Monospace), color = color)
        else -> Words(row.styled(c, zoom), style = if (row.heading != null) Type.headline else Type.body, color = color)
    }
}

// Zoomed into a document: who has it and who can see it, as the desktop's Assigned to and Visible to fields; a tap
// changes either, and someone assigned who cannot open it is named, with Grant access where the document's own list
// is its audience (renderer/access.js hiddenFromFix)
@Composable
fun NodeDetails(id: String, access: Access, engine: Engine, open: () -> Unit, reload: suspend () -> Unit) {
    val c = Theme.colors
    Column(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
        if (access.task) Field("Assigned to", { engine.assigning = Engine.Assigning(id, access.assignees.map { it.id }, reload) }) {
            if (access.assignees.isEmpty()) Text("Unassigned", color = c.secondary) else Faces(access.assignees.persons)
        }
        Field("Visible to", open) {
            if (access.audience == "people" && access.people.isNotEmpty()) Faces(access.people.persons) else AudienceLabel(access.audience, access.space)
        }
        if (access.hidden.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Outlined.WarningAmber, null, Modifier.size(18.dp), c.warning)
                Text("Not visible to " + access.hidden.names, Modifier.weight(1f), style = Type.subheadline, color = c.warning)
                if (access.grants) OutlinedButton({ engine.scope.launch { engine.share(id, "people", access.participants + access.hidden.map { it.id }); reload() } }) { Text("Grant access", color = c.text) }
            }
            HorizontalDivider(color = c.separator)
        }
    }
}

// a field as the desktop draws one: its name in grey, its value after it, a line under it, the whole row the button
// that changes it
@Composable
private fun Field(name: String, change: () -> Unit, value: @Composable () -> Unit) {
    val c = Theme.colors
    Row(Modifier.fillMaxWidth().clickable(onClick = change).padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(name, Modifier.width(100.dp), color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        value()
        Spacer(Modifier.weight(1f))
    }
    HorizontalDivider(color = c.separator)
}

// Three dots where the answer will be, as the desktop's (renderer/chat.js chatDotsEl); still with animations off
@Composable
fun Dots(still: Boolean, modifier: Modifier = Modifier) {
    val c = Theme.colors
    val t by rememberInfiniteTransition().animateFloat(0f, 6.2832f, infiniteRepeatable(tween(1570, easing = LinearEasing)))
    Row(modifier.clearAndSetSemantics { contentDescription = "Tana is writing" }, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        for (i in 0 until 3) {
            val a = if (still) 0.5f else 0.25f + 0.75f * kotlin.math.max(0f, kotlin.math.sin(t * 4 - i * 0.9f))
            Box(Modifier.size(7.dp).alpha(a).background(c.secondary, CircleShape))
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
                    ChoiceRow(p.name, on, last = i == shown.size - 1) { picked = if (on) picked - p.id else picked + p.id }
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
