package com.dreetje.orbital.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.dreetje.orbital.Dictation
import com.dreetje.orbital.Agent
import com.dreetje.orbital.Engine
import com.dreetje.orbital.Field
import com.dreetje.orbital.Lists
import com.dreetje.orbital.Member
import com.dreetje.orbital.Preset
import com.dreetje.orbital.TaskType
import com.dreetje.orbital.Times
import com.dreetje.orbital.Value
import com.dreetje.orbital.matching
import kotlin.time.Instant
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.datetime.LocalDate
import kotlinx.datetime.TimeZone
import kotlinx.datetime.atStartOfDayIn
import kotlinx.datetime.toLocalDateTime

// The iPhone's ios/Orbital/QuickAdd.swift: Quick Add, and the pickers behind Assign to

// Quick Add Task, as the desktop's (task.js, ⇧⌘Space): a title and the type the task is made with, plain Task or one of
// the workflow types you may create in, the type's fields and whom it is for, or an image read into a task or a note
// instead (main.js ai:processImage): from the photo picker, or from the clipboard when it holds one. A made task is
// never reported as a failure. Add closes it at once and the engine makes the task while you go on (Engine.add); it is
// closed by Cancel or Back, never by a swipe down, so what you were typing is not lost to a stray swipe.
@Composable
fun QuickAdd(engine: Engine, shared: Engine.Shared? = null, search: String? = null, onDismiss: () -> Unit) {
    val c = Theme.colors
    var title by rememberSaveable { mutableStateOf("") } // what you typed survives a rotation
    var types by remember { mutableStateOf(listOf<TaskType>()) }
    var type by remember { mutableStateOf<String?>(null) } // null: plain Task
    var preset by remember { mutableStateOf<Preset?>(null) }
    var fields by remember { mutableStateOf(listOf<Field>()) } // the chosen type's, to set before adding
    var values by remember { mutableStateOf(mapOf<String, Value>()) } // field key -> what is set in it
    var assignee by remember { mutableStateOf<Member?>(null) } // whom a task is for; null: you
    var today by rememberSaveable { mutableStateOf(false) } // Pin to today, off until you turn it on
    var failure by remember { mutableStateOf<String?>(null) }
    var kept by remember { mutableStateOf<Engine.Draft?>(null) } // a task Tana did not take, opened again (Engine.unsent)
    var picking by remember { mutableStateOf<Field?>(null) } // a person or link field's list open; assignee when key is ""
    var dating by remember { mutableStateOf<Field?>(null) } // a date field's picker open
    val dictation = remember { Dictation(engine.platform, engine.scope) }
    DisposableEffect(Unit) { onDispose { dictation.cancel() } } // closed or rotated while listening: the microphone stops
    var taken by rememberSaveable { mutableStateOf(false) } // what was shared or not added is read once, not again after a rotation
    val focus = remember { FocusRequester() }
    val keyboard = LocalFocusManager.current
    val hasClip = remember { engine.platform.hasClipboardImage() }
    // a task is assigned; a document of a type without a workflow (a Goal) is not
    val isTask = type?.let { t -> types.firstOrNull { it.uri == t } }?.task != false

    Sheet({ dictation.cancel(); onDismiss() }, swipe = false) { close ->
        fun append(said: String) { title = Dictation.join(title, said) }

        // Add while listening or still transcribing: the words are waited for, then the task is made; one whose words did
        // not come is not made, so nothing said is lost without a word
        suspend fun add() {
            if (dictation.settling || !dictation.settled(::append)) return
            val words = title.trim()
            if (words.isEmpty()) return
            engine.add(Engine.Draft(words, type, if (kept != null) kept?.search else search, assignee, values, today))
            close()
        }

        // an image is read and made into its node behind the turning +, and opens once it is made (Engine.addImage)
        val pickPhoto = engine.platform.rememberPhotoPicker { jpeg -> engine.addImage { jpeg }; close() }

        LaunchedEffect(Unit) {
            val first = !taken
            taken = true
            if (first && title.isEmpty()) shared?.text?.let { title = it }
            // a task Tana did not take: back as it was, with why
            if (first && shared == null && engine.unsent.isNotEmpty()) engine.unsent.removeAt(0).let { d ->
                kept = d; title = d.title; assignee = d.assignee; today = d.today; failure = d.why?.let { "Not added: $it" }
            }
            if (shared?.image == null) runCatching { focus.requestFocus() } // a shared image's row stays in view, not under the keyboard
            types = engine.taskTypes()
            // a saved search of one type: that type, chosen, and listed even when it is no task type (a Goal is a document)
            val from = if (kept != null) kept?.search else search
            if (from != null) engine.searchPreset(from)?.let { found ->
                preset = found
                if (types.none { it.uri == found.uri }) types = listOf(TaskType(found.uri, found.title, found.task)) + types
                type = found.uri
            }
            kept?.let { type = it.type }
        }
        // the chosen type's fields, with the saved search's values when it is its type
        LaunchedEffect(type) {
            fields = type?.let { engine.typeFields(it) } ?: emptyList()
            values = kept?.takeIf { it.type == type }?.values ?: preset?.takeIf { it.uri == type }?.fields ?: emptyMap()
        }

        val open = picking
        if (open != null) {
            if (open.key.isEmpty()) Choices("Assign to", "You", { q -> engine.members().sortedBy { it.name.lowercase() }.matching(q) },
                current = { it == assignee?.id }, back = { picking = null }) { assignee = it; picking = null }
            else Choices(open.title, "None", { q -> engine.fieldChoices(open.key, q) }, current = { it == values[open.key]?.ref }, back = { picking = null }) { m ->
                values = if (m == null) values - open.key else values + (open.key to Value(ref = m.id, label = m.name)); picking = null
            }
            return@Sheet
        }

        val canAdd = (title.isNotBlank() || dictation.busy) && !dictation.settling
        SheetBar("Quick Add", cancel = close, action = "Add", enabled = canAdd) { engine.scope.launch { add() } }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(Modifier.fillMaxSize()) {
                // an image shared to Orbital, read only once it is tapped (Shell: any app can start the share screen)
                shared?.image?.let { image ->
                    item("shared") {
                        Group("Shared image", footer = "Read with your ChatGPT account into a task or a note, with the image under it.") {
                            GroupRow(last = true, onClick = { engine.addImage { image }; close() }) { Icon(Icons.Outlined.Image, null, tint = c.text); Text("Process the shared image", color = c.text) }
                        }
                    }
                }
                item("title") {
                    // the title, and dictating it: the microphone starts listening; while it listens, ✕ throws the
                    // recording away and ■ stops it, its words then added to the title
                    Group(footer = dictation.problem) {
                        GroupRow(last = true) {
                            if (!dictation.recording) BasicTextField(title, { title = it }, Modifier.weight(1f).focusRequester(focus).semantics { contentDescription = "New task" },
                                textStyle = Type.body.copy(color = c.text), cursorBrush = SolidColor(c.accent),
                                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { if (canAdd) engine.scope.launch { add() } }),
                                decorationBox = { inner -> Box { if (title.isEmpty()) Text("New task", style = Type.body, color = c.secondary); inner() } })
                            Dictate(dictation, engine, ::append)
                        }
                    }
                }
                item("types") {
                    val all = listOf(TaskType(null, "Task")) + types
                    Group("Type", footer = preset?.takeIf { type == it.uri && it.fields.isNotEmpty() }?.let { "With the " + (if (it.fields.size == 1) "value" else "values") + " this saved search sets." }) {
                        all.forEachIndexed { i, t ->
                            GroupRow(last = i == all.size - 1, selected = type == t.uri, onClick = { type = t.uri; keyboard.clearFocus() }) { // the keyboard put away, the details under it in reach
                                Glyph(if (t.task == false) "doc" else "task", Modifier.size(20.dp), c.text)
                                Text(t.title, Modifier.weight(1f), color = c.text)
                                if (type == t.uri) Icon(Icons.Filled.Check, null, Modifier.size(20.dp), c.accent)
                            }
                        }
                    }
                }
                // Details: whom a task is for, whether it is pinned to today, and the chosen type's fields, a saved
                // search's values already in them
                item("details") {
                    Group("Details") {
                        if (isTask) GroupRow(onClick = { picking = Field("", "Assign to", "member") }) {
                            Text("Assigned to", Modifier.weight(1f), color = c.text); Text(assignee?.name ?: "You", color = c.secondary)
                        }
                        // the whole row flips it, the switch in its own colour (in the rows' text colour it is white on white)
                        GroupRow(last = fields.isEmpty(), onClick = { today = !today }) {
                            Text("Pin to today", Modifier.weight(1f), color = c.text)
                            Switch(today, { today = it }, Modifier.semantics { contentDescription = "Pin to today" },
                                colors = SwitchDefaults.colors(checkedTrackColor = c.done, checkedThumbColor = Color.White, checkedBorderColor = c.done))
                        }
                        fields.forEachIndexed { i, f -> FieldRow(f, values[f.key], last = i == fields.size - 1, set = { v -> values = if (v == null) values - f.key else values + (f.key to v) },
                            pick = { picking = f }, date = { dating = f }) }
                    }
                }
                item("image") {
                    Group("Image", footer = "Read with your ChatGPT account into a task or a note, with the image under it.") {
                        GroupRow(last = !hasClip, onClick = pickPhoto) { Icon(Icons.Outlined.Image, null, tint = c.text); Text("Process image from Photos", color = c.text) }
                        if (hasClip) GroupRow(last = true, onClick = { engine.addImage { engine.platform.pasteImage() }; close() }) {
                            Icon(Icons.Outlined.ContentPaste, null, tint = c.text); Text("Process image from clipboard", color = c.text)
                        }
                    }
                }
            }
        }
        failure?.let { Notice(it) }
    }

    dating?.let { f ->
        val now = values[f.key]?.ref?.let(Lists::parsePlainDate)?.let { (y, m, d) -> LocalDate(y, m, d).atStartOfDayIn(TimeZone.UTC).toEpochMilliseconds() }
        val state = rememberDatePickerState(initialSelectedDateMillis = now ?: engine.now().toEpochMilliseconds())
        DatePickerDialog({ dating = null }, confirmButton = {
            TextButton({
                state.selectedDateMillis?.let { ms -> val d = Instant.fromEpochMilliseconds(ms).toLocalDateTime(TimeZone.UTC).date; values = values + (f.key to Value(ref = Lists.plainDate(d.year, d.month.ordinal + 1, d.day))) }
                dating = null
            }) { Text("Done") }
        }, dismissButton = { TextButton({ dating = null }) { Text("Cancel") } }) { DatePicker(state) }
    }
}

// One field, by its kind: a choice from its options, words, a day, or a person or node picked from a list
@Composable
private fun FieldRow(f: Field, value: Value?, last: Boolean, set: (Value?) -> Unit, pick: () -> Unit, date: () -> Unit) {
    val c = Theme.colors
    when (f.kind) {
        "options" -> {
            var open by remember { mutableStateOf(false) }
            GroupRow(last = last, onClick = { open = true }) {
                Text(f.title, Modifier.weight(1f), color = c.text)
                Box { Text(value?.text ?: "None", color = c.secondary)
                    DropdownMenu(open, { open = false }) {
                        DropdownMenuItem({ Text("None") }, { set(null); open = false })
                        for (o in f.options) DropdownMenuItem({ Text(o) }, { set(Value(text = o)); open = false })
                    }
                }
            }
        }
        "text" -> GroupRow(last = last) {
            BasicTextField(value?.text ?: "", { set(if (it.isEmpty()) null else Value(text = it)) }, Modifier.weight(1f).semantics { contentDescription = f.title },
                textStyle = Type.body.copy(color = c.text), cursorBrush = SolidColor(c.accent),
                decorationBox = { inner -> Box { if (value?.text.isNullOrEmpty()) Text(f.title, color = c.secondary); inner() } })
        }
        "date" -> GroupRow(last = last, onClick = date) {
            Text(f.title, Modifier.weight(1f), color = c.text)
            val day = value?.ref?.let(Lists::parsePlainDate)
            Text(day?.let { (y, m, d) -> Times.long(LocalDate(y, m, d)) } ?: "None", color = c.secondary)
            if (day != null) IconButton({ set(null) }, Modifier.size(28.dp)) { Icon(Icons.Filled.Close, "Clear " + f.title, Modifier.size(18.dp), c.tertiary) }
        }
        else -> GroupRow(last = last, onClick = pick) { // a person or a link
            Text(f.title, Modifier.weight(1f), color = c.text); Text(value?.label ?: "None", color = c.secondary)
        }
    }
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
        if (query.isEmpty()) item("none") { Group { ChoiceRow(none, current(null), last = true) { pick(null) } } }
        item("all") {
            if (items.isNotEmpty()) Group {
                items.forEachIndexed { i, m -> ChoiceRow(m.name, current(m.id), last = i == items.size - 1) { pick(m) } }
            }
        }
    }
}

// Long press, Assign to …: your Dot on top (each agent linked through orbital.md that is on, the default first), then the
// workspace's people, searchable, whoever has it ticked. A tap on your Dot asks what it should do (HandForm, in this same
// sheet), and on your Dot when it has the node takes it back; a tap on a person gives the task to that person alone, as
// the desktop's Assign to … does, and Unassigned takes everyone off it, your Dot included. A note lists only your Dot.
@Composable
fun AssignSheet(engine: Engine, task: Engine.Assigning, onDismiss: () -> Unit) {
    val c = Theme.colors
    var people by remember { mutableStateOf(listOf<Member>()) }
    var loaded by remember { mutableStateOf(!task.people) } // the people read (a note lists only your agents)
    var query by remember { mutableStateOf("") }
    var asking by remember { mutableStateOf<Agent?>(null) } // your Dot picked: what it should do, in this same sheet
    var held by remember { mutableStateOf(false) } // a request written or on its way: no swipe throws it away
    LaunchedEffect(Unit) { if (task.people) { people = engine.members().sortedBy { it.name.lowercase() }; loaded = true } }
    Sheet(onDismiss, swipe = !held) { close ->
        val a = asking
        if (a != null) HandForm(engine, Engine.Handing(task.id, a, task.then), back = { asking = null; held = false }, done = close) { held = it }
        else {
            val handedTo = engine.handed[task.id]
            val pick = { m: Member? ->
                close()
                engine.scope.launch {
                    if (m == null && handedTo != null) engine.unhand(task.id) // Unassigned: your Dot too
                    engine.assign(task.id, m?.id, task.then); task.then()
                }
            }
            val agents = engine.agentsOn.filter { query.isEmpty() || it.name.contains(query, ignoreCase = true) }
            val shown = people.matching(query)
            SheetBar("Assign to", cancel = close)
            SearchField(query, { query = it })
            // nothing found, as Choices says it
            if (loaded && query.isNotEmpty() && agents.isEmpty() && shown.isEmpty()) { Empty("No results", "Nothing matches “$query”.", icon = Icons.Outlined.Search); return@Sheet }
            LazyColumn(Modifier.fillMaxWidth()) {
                item { Spacer(Modifier.padding(top = 4.dp)) }
                if (agents.isNotEmpty()) item("agents") {
                    Group {
                        agents.forEachIndexed { i, agent ->
                            val on = handedTo == agent.id
                            GroupRow(last = i == agents.size - 1, selected = on, onClick = {
                                if (on) { close(); engine.scope.launch { engine.unhand(task.id); task.then() } } else asking = agent
                            }) { Glyph("robot", Modifier.size(20.dp), c.text); Text(agent.name, Modifier.weight(1f), color = c.text); Tick(on) }
                        }
                    }
                }
                if (task.people && query.isEmpty()) item("none") {
                    // not known (a Timeline task): none ticked; Unassigned only when no one has it, your Dot included
                    Group { ChoiceRow("Unassigned", task.current?.let { it.isEmpty() && handedTo == null } ?: false, last = true) { pick(null) } }
                }
                if (task.people && shown.isNotEmpty()) item("people") {
                    Group { shown.forEachIndexed { i, m -> ChoiceRow(m.name, task.current == listOf(m.id), last = i == shown.size - 1) { pick(m) } } }
                }
            }
        }
    }
}
