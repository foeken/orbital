package com.dreetje.orbital.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.widthIn
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateListOf
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.IconButton
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.dreetje.orbital.Access
import com.dreetje.orbital.Engine
import com.dreetje.orbital.Failure
import com.dreetje.orbital.Lists
import com.dreetje.orbital.Member
import com.dreetje.orbital.Phrases
import com.dreetje.orbital.matching
import com.dreetje.orbital.Row as Node
import com.dreetje.orbital.Times
import com.dreetje.orbital.kindOf
import com.dreetje.orbital.names
import com.dreetje.orbital.parseTime
import com.dreetje.orbital.persons
import kotlinx.coroutines.launch

// The iPhone's ios/Orbital/Pages.swift: a node zoomed into (an outline, a saved search, a meeting) and who
// has it and who sees it

// A node opened from outside the app (Pages.swift Viewer): an orbital: link, Echo's, another app's or a widget's, opens
// in a sheet over wherever you were, with a stack of its own, so a mention in it opens in the sheet and Back or a swipe
// down leaves your place as it was. The page is NodeScreen, live as anywhere else.
@Composable
fun Viewer(engine: Engine, id: String, onClose: () -> Unit) {
    val stack = remember(id) { mutableStateListOf(id) }
    Sheet(onClose) { close ->
        val back: () -> Unit = { if (stack.size > 1) stack.removeAt(stack.lastIndex) else close() }
        PlatformBack(stack.size > 1, onBack = back)
        CompositionLocalProvider(LocalZoom provides { to -> if (to != null) stack.add(to) }) {
            NodeScreen(engine, stack.last(), Modifier.background(Theme.colors.page).navigationBarsPadding(), onBack = back)
        }
    }
}

// Zoomed into a node: a saved search as its results, a meeting as its attendees and your
// notes, its summary once Tana wrote it up (Notes | Summary over it when you have notes too), anything else as its
// outline; a chat stays on the Mac. A mention, a reference or a row opens the node it names.
@Composable
fun NodeScreen(
    engine: Engine,
    id: String,
    modifier: Modifier = Modifier,
    titled: Boolean = true, // false when the page is the menu's own and the shell names it
    onBack: (() -> Unit)? = null,
) {
    val c = Theme.colors
    val scope = rememberCoroutineScope()
    var page by remember(id) { mutableStateOf(engine.cached(id)) } // back to a page: the last read of it at once, as NavigationStack keeps it
    var error by remember(id) { mutableStateOf<String?>(null) }
    var access by remember(id) { mutableStateOf<Access?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var assigningVisibility by remember { mutableStateOf(false) }
    var showNotes by remember(id) { mutableStateOf(false) } // a meeting's Notes | Summary: Summary first
    var everyone by remember(id) { mutableStateOf(false) } // a meeting's attendees past the first five shown
    val chat = kindOf(id) == "chat" // never read: a chat can be megabytes

    // A read keeps what is on screen when it fails, and says why only while there is nothing to show
    suspend fun load() {
        if (chat) return
        try { page = engine.open(id); error = null } catch (e: Failure) { error = e.message }
        val kind = page?.kind
        if (kind != null && kind !in listOf("search", "event")) access = engine.access(id) ?: access
    }

    LaunchedEffect(engine.phase, id) {
        if (engine.phase != Engine.Phase.Ready) return@LaunchedEffect
        load()
    }
    // Changed in Tana, by anyone anywhere (ios/engine/live.js): read again, as the desktop's page on screen is. A saved
    // search or a meeting takes a row added, changed or gone.
    val changed = engine.changes[id]
    LaunchedEffect(changed) { if (changed != null) load() }
    // marked or unmarked on another device: drawn again; only on a change, as the iPhone's onChange, or a page opened from
    // its last read was read twice over
    var readSensitive by remember(id) { mutableStateOf(engine.sensitiveIds) }
    LaunchedEffect(engine.sensitiveIds) { if (engine.sensitiveIds != readSensitive) { readSensitive = engine.sensitiveIds; if (page != null) load() } }
    // Demo mode turned on or off with this page open: read again, and none of the words read before it shown meanwhile
    var readInDemo by remember(id) { mutableStateOf(engine.demo) }
    LaunchedEffect(engine.demo) { if (engine.demo != readInDemo) { readInDemo = engine.demo; page = null; load() } }
    val refresh: () -> Unit = { scope.launch { refreshing = true; load(); refreshing = false } }

    val current = page
    val hiddenPage = current?.sensitive == true && !engine.reveal
    Column(modifier.fillMaxSize()) {
        // a document's pins: the days it is pinned to under its title, and the pin menu at the top right (PinButton)
        val pins = access?.let { Phrases.pinnedTo(engine.pinDays(id), Times.key(engine.now()), Times.key(engine.now(), 1)) }
        if (titled) PageBar(if (hiddenPage) "" else engine.translator.words(current?.title ?: "", current?.sensitive == true).first, onBack = onBack,
            subtitle = pins, action = if (access != null) ({ PinButton(id, engine) { load() } }) else null)
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                chat -> Empty("Chats are on the Mac", "Open this chat in Orbital on your Mac.", glyph = "discuss")
                current != null && hiddenPage -> Empty("Hidden", "You marked this sensitive in Orbital. Shake your phone or turn on Show sensitive items in Settings to see it, and do the same again to hide it.", glyph = "hidden")
                // a meeting, read only, as the desktop's meeting page (renderer/meetingnotes.js, renderer/fields.js
                // attendeesFieldEl): its attendees, five and "And n more" past that, then your notes or its summary
                current?.kind == "event" -> PullToRefreshBox(refreshing, refresh, Modifier.fillMaxSize()) {
                    val notes = current.notes
                    val people = current.attendees ?: emptyList()
                    val summary = current.summary
                    val flat = Lists.flat(if (summary == null || (showNotes && notes != null)) notes ?: emptyList() else summary)
                    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 8.dp, bottom = 8.dp)) {
                        val key = uniqueKeys()
                        if (people.isNotEmpty()) item("attendees") {
                            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text("Attendees", Modifier.width(100.dp), color = c.secondary, maxLines = 1)
                                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    val shown = if (everyone) people else people.take(5)
                                    shown.forEach { Text(it.name, color = c.text) }
                                    if (shown.size < people.size) Text("And ${people.size - shown.size} more", Modifier.clickable { everyone = true }, color = c.secondary)
                                }
                            }
                        }
                        if (summary != null && notes != null) item("switch") {
                            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                                listOf(true to "Notes", false to "Summary").forEachIndexed { i, (n, label) ->
                                    SegmentedButton(showNotes == n, { showNotes = n }, SegmentedButtonDefaults.itemShape(i, 2)) { Text(label) }
                                }
                            }
                        }
                        flat.forEach { (row, depth, number) -> item(key("block:" + row.id)) { OutlineRow(row, depth, engine, number) } }
                        if (flat.isEmpty()) item("empty") { Text("No notes yet", Modifier.padding(horizontal = 16.dp, vertical = 12.dp), color = c.secondary) }
                    }
                }
                current != null -> when (current.kind) {
                    "search" -> PullToRefreshBox(refreshing, refresh, Modifier.fillMaxSize()) {
                        val rows = engine.shown(current.rows)
                        // in the sections the search was saved with (Row.group), as the desktop shows it: no lines, and the
                        // rows closer together under headings (the iPhone's Pages.swift)
                        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 6.dp, bottom = 6.dp)) {
                            val key = uniqueKeys()
                            val sections = Lists.sections(rows)
                            val grouped = sections.any { it.first != null }
                            sections.forEachIndexed { s, (title, list) ->
                                if (title != null) item("h$s") { Text(title, Modifier.padding(start = 16.dp, top = 14.dp, bottom = 4.dp).semantics { heading() }, style = Type.headline, color = c.secondary) }
                                list.forEach { row -> item(key("row:" + row.id)) { ListRow(row, engine, tight = grouped) { load() } } }
                            }
                        }
                        if (current.rows.isEmpty()) Empty("Nothing found", glyph = Glyphs.of(current.kind))
                    }
                    else -> PullToRefreshBox(refreshing, refresh, Modifier.fillMaxSize()) {
                        val flat = Lists.flat(current.rows)
                        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 8.dp, bottom = 8.dp)) {
                            val key = uniqueKeys()
                            access?.let { a -> item("details") { NodeDetails(id, a, engine, open = { assigningVisibility = true }) { load() } } }
                            flat.forEach { (row, depth, number) -> item(key("block:" + row.id)) { OutlineRow(row, depth, engine, number) } }
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
// is its own button beside it, so ticking a task never opens it too. tight: under a saved search's headings, closer together
@Composable
fun ListRow(row: Node, engine: Engine, tight: Boolean = false, reload: suspend () -> Unit) {
    val c = Theme.colors
    val zoom = LocalZoom.current
    val hidden = row.sensitive == true && !engine.reveal
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        if (row.stateType != null) TaskBox(row, engine, onBaseline(4.dp))
        else Glyph(Glyphs.of(row.icon), onBaseline(4.dp, Modifier.size(20.dp)), c.secondary)
        NodeMenu(row.target, engine, Modifier.weight(1f).alignByBaseline(), task = if (row.stateType != null) engine.state(row) else null, assignees = row.assignees, then = reload, onClick = { zoom(row.target) }) {
            Column(Modifier.fillMaxWidth().padding(vertical = if (tight) 7.dp else 9.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
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
// its node's glyph and name, which opens it; an image its picture, the word Image until it has come (or in the sample)
@Composable
fun OutlineRow(row: Node, depth: Int, engine: Engine, number: Int? = null) { // number: its place in a numbered list (Lists.flat)
    val c = Theme.colors
    val zoom = LocalZoom.current
    val density = LocalDensity.current
    val ref = row.reference
    val reveal = engine.reveal
    val style = when (row.heading) { null -> Type.body; 1 -> Type.title2; 2 -> Type.title3; else -> Type.headline }
    val uri = row.image?.uri
    var picture by remember(uri) { mutableStateOf<ImageBitmap?>(null) }
    if (uri != null) LaunchedEffect(uri) { picture = engine.image(uri) }
    Row(
        Modifier.fillMaxWidth()
            .then(if (ref != null) Modifier.clickable { zoom(ref.uri) }.semantics { role = Role.Button } else Modifier)
            .padding(start = 16.dp + 22.dp * depth, end = 16.dp, top = if (row.heading != null) 14.dp else 4.dp, bottom = 4.dp), // 8 dp between blocks, as Tana spaces them
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (row.heading == null) { // a marker only where Tana draws one: a paragraph has none
            if (ref != null) Glyph(Glyphs.ofUri(ref.uri), onBaseline(3.5.dp, Modifier.size(18.dp)), c.secondary)
            else if (number != null) Text("$number.", Modifier.widthIn(min = 18.dp).alignByBaseline(), style = style, color = c.secondary, textAlign = TextAlign.End)
            // centred on the lower-case letters
            else if (row.block == "bullet") Box(onBaseline((-2.5).dp, Modifier.width(18.dp).height(6.dp)), contentAlignment = Alignment.Center) {
                Box(Modifier.size(6.dp).background(c.tertiary, CircleShape))
            }
        }
        Sensitive(row, reveal, Modifier.weight(1f).alignByBaseline()) {
            val shown = picture?.takeIf { row.sensitive != true || reveal }
            if (row.type == "image" && shown != null) Image(shown, "Image", Modifier.fillMaxWidth().heightIn(max = 360.dp).clip(RoundedCornerShape(8.dp)), alignment = Alignment.TopStart, contentScale = ContentScale.Fit)
            else if (row.type == "image" || row.type == "table") Text(if (row.type == "image") "Image" else "Table", style = style, color = c.secondary)
            else Words(row.styled(c, zoom), style = style, modifier = if (row.heading != null) Modifier.semantics { heading() } else Modifier)
        }
    }
}

// Zoomed into a document: who has it and who can see it, as the desktop's Assigned to and Visible to fields; a tap
// changes either, and someone assigned who cannot open it is named, with Grant access where the document's own list
// is its audience (renderer/access.js hiddenFromFix)
@Composable
fun NodeDetails(id: String, access: Access, engine: Engine, open: () -> Unit, reload: suspend () -> Unit) {
    val c = Theme.colors
    Column(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
        // Status: Tana's own four, as the desktop's Status pill offers them (renderer/pills.js); set outright (engine.tick)
        if (access.task) {
            val now = engine.states[id] ?: access.state ?: "open"
            var menu by remember { mutableStateOf(false) }
            Column {
                Field("Status", { menu = true }) { Text(Phrases.state(now), color = c.text) }
                DropdownMenu(menu, { menu = false }) {
                    Phrases.states.forEach { (state, word) ->
                        DropdownMenuItem({ Text(word, color = c.text) }, { menu = false; engine.scope.launch { engine.tick(id, state); reload() } },
                            trailingIcon = if (state == now) ({ Icon(Icons.Outlined.Check, null, tint = c.text) }) else null)
                    }
                }
            }
        }
        if (access.task) Field("Assigned to", { engine.assigning = Engine.Assigning(id, access.assignees.map { it.id }, reload) }) {
            if (access.assignees.isEmpty()) Text("Unassigned", color = c.secondary) else Faces(access.assignees.persons)
        }
        Field("Visible to", open) {
            if (access.audience == "people" && access.people.isNotEmpty()) Faces(access.people.persons) else AudienceLabel(access.audience, access.space)
        }
        // its pins are the pin menu in the top bar (NodeScreen, PinButton); an outside orbital:pin: link opens the node there
        // handed to your Dot (Agents.kt): its name and its last Agent status line; a tap asks it again or takes it back
        access.agent?.let { held ->
            var menu by remember { mutableStateOf(false) }
            Column {
                Field("Agent", { menu = true }) { Glyph("robot", Modifier.size(18.dp), c.text); Text(held.name + " · " + held.word, color = c.text) }
                DropdownMenu(menu, { menu = false }) {
                    engine.agents.firstOrNull { it.id == held.id }?.let { a -> DropdownMenuItem({ Text("Ask ${a.name} again …", color = c.text) }, { menu = false; engine.handing = Engine.Handing(id, a, reload) }) }
                    DropdownMenuItem({ Text("Unassign", color = c.danger) }, { menu = false; engine.scope.launch { engine.unhand(id); reload() } })
                }
            }
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
// The top bar's pin button on a document's page (Pages.swift NodeScreen): the pin menu, the glyph in the text colour
// while it is pinned from today on
@Composable
fun PinButton(id: String, engine: Engine, then: suspend () -> Unit) {
    val c = Theme.colors
    var open by remember { mutableStateOf(false) }
    val ahead = Phrases.pinnedTo(engine.pinDays(id), Times.key(engine.now()), Times.key(engine.now(), 1))
    Box {
        IconButton({ open = true }, Modifier.semantics { stateDescription = ahead ?: "Not pinned" }) {
            Glyph("pinDate", Modifier.size(20.dp), if (ahead == null) c.secondary else c.text, description = "Pin")
        }
        DropdownMenu(open, { open = false }) { PinChoices(id, engine, { open = false }, then) }
    }
}

// A node's pin menu: today, tomorrow and each later day it is pinned to, ticked where it is (Phrases.pinChoices), then
// Pick a Date … and Remove All Pins. The pin button at the top of its page and the long press's Pin to … both show it
// (Pages.swift PinChoices).
@Composable
fun PinChoices(id: String, engine: Engine, close: () -> Unit, then: suspend () -> Unit = {}) {
    val c = Theme.colors
    val days = engine.pinDays(id)
    val today = Times.key(engine.now())
    val tomorrow = Times.key(engine.now(), 1)
    val run: (suspend () -> Unit) -> () -> Unit = { act -> { close(); engine.scope.launch { act(); then() } } }
    Phrases.pinChoices(days, today, tomorrow).forEach { (day, on) ->
        DropdownMenuItem({ Text(Phrases.pinDay(day, today, tomorrow), color = c.text) }, run { engine.pinDay(id, day, !on) },
            trailingIcon = if (on) ({ Icon(Icons.Outlined.Check, "Pinned", tint = c.text) }) else null)
    }
    HorizontalDivider(color = c.separator)
    DropdownMenuItem({ Text("Pick a Date …", color = c.text) }, { close(); engine.pickingDay = Engine.PickingDay(id, then) },
        leadingIcon = { Icon(Icons.Outlined.CalendarMonth, null, tint = c.text) })
    if (days.isNotEmpty()) {
        HorizontalDivider(color = c.separator)
        DropdownMenuItem({ Text("Remove All Pins", color = c.danger) }, run { engine.pin(id, false) }, leadingIcon = { Icon(Icons.Outlined.PushPin, null, tint = c.danger) })
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

// renderer/tasks.js AUDIENCES: the scope's glyph and its word, a space by its name
@Composable
fun AudienceLabel(scope: String, space: String?, glyphs: Boolean = true) {
    val c = Theme.colors
    val (word, glyph) = Phrases.audience(scope, space)
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
    val shown = people.matching(query)
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
