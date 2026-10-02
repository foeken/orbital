package com.dreetje.orbital.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.dreetje.orbital.Dictation
import com.dreetje.orbital.Engine
import com.dreetje.orbital.Failure
import com.dreetje.orbital.Field
import com.dreetje.orbital.Lists
import com.dreetje.orbital.Member
import com.dreetje.orbital.Preset
import com.dreetje.orbital.TaskType
import com.dreetje.orbital.Times
import com.dreetje.orbital.Value
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.datetime.LocalDate
import kotlinx.datetime.TimeZone
import kotlinx.datetime.atStartOfDayIn
import kotlinx.datetime.toLocalDateTime
import kotlin.time.Instant

// Quick Add Task, as the desktop's (task.js, ⇧⌘Space): a title and the type the task is made with, plain Task or one of
// the workflow types you may create in, the type's fields and whom it is for, or an image read into a task or a note
// instead (main.js ai:processImage): from the photo picker, or from the clipboard when it holds one. A made task is
// never reported as a failure.
@Composable
fun QuickAdd(engine: Engine, shared: Engine.Shared? = null, search: String? = null, onDismiss: () -> Unit) {
    val c = Theme.colors
    val zoom = LocalZoom.current
    var title by remember { mutableStateOf("") }
    var types by remember { mutableStateOf(listOf<TaskType>()) }
    var type by remember { mutableStateOf<String?>(null) } // null: plain Task
    var preset by remember { mutableStateOf<Preset?>(null) }
    var fields by remember { mutableStateOf(listOf<Field>()) } // the chosen type's, to set before adding
    var values by remember { mutableStateOf(mapOf<String, Value>()) } // field key -> what is set in it
    var assignee by remember { mutableStateOf<Member?>(null) } // whom a task is for; null: you
    var working by remember { mutableStateOf<String?>(null) } // "Adding…", "Reading the image…"
    var failure by remember { mutableStateOf<String?>(null) }
    var picking by remember { mutableStateOf<Field?>(null) } // a person or link field's list open; assignee when key is ""
    var dating by remember { mutableStateOf<Field?>(null) } // a date field's picker open
    val dictation = remember { Dictation(engine.platform, engine.scope) }
    val focus = remember { FocusRequester() }
    val hasClip = remember { engine.platform.hasClipboardImage() }
    // a task is assigned; a document of a type without a workflow (a Goal) is not
    val isTask = type?.let { t -> types.firstOrNull { it.uri == t } }?.task != false

    Sheet({ dictation.cancel(); onDismiss() }) { close ->
        fun append(said: String) { title = if (title.isEmpty()) said else "$title $said" }

        // the image read and made into its node, which then opens, as the desktop opens it
        suspend fun process(jpeg: ByteArray) {
            working = "Reading the image…"
            // shared while Orbital was not running: Tana connects first; signed out or failed, it says so rather than waiting for ever
            while (engine.phase != Engine.Phase.Ready) {
                if (engine.phase != Engine.Phase.Starting) { failure = "Sign in to Tana first, then share it again"; working = null; return }
                delay(200)
            }
            try { val id = engine.processImage(jpeg); close(); zoom(id) } catch (e: Failure) { failure = e.message }
            working = null
        }

        // Add while listening or still transcribing: the words are waited for, then the task is made; one whose words did
        // not come is not made, so nothing said is lost without a word
        suspend fun add() {
            if (dictation.recording || dictation.transcribing) {
                working = "Transcribing…"
                if (!dictation.settle(::append)) { working = null; return }
            }
            val words = title.trim()
            if (words.isEmpty()) { working = null; return }
            working = "Adding…"
            try { engine.createTask(words, type, search, assignee?.id, values); close() } catch (e: Failure) { failure = e.message }
            working = null
        }

        val pickPhoto = engine.platform.rememberPhotoPicker { jpeg -> engine.scope.launch { process(jpeg) } }

        LaunchedEffect(Unit) {
            shared?.image?.let { process(it); return@LaunchedEffect }
            if (title.isEmpty()) shared?.text?.let { title = it }
            runCatching { focus.requestFocus() }
            types = engine.taskTypes()
            // a saved search of one type: that type, chosen, and listed even when it is no task type (a Goal is a document)
            if (search != null) engine.searchPreset(search)?.let { found ->
                preset = found
                if (types.none { it.uri == found.uri }) types = listOf(TaskType(found.uri, found.title, found.task)) + types
                type = found.uri
            }
        }
        // the chosen type's fields, with the saved search's values when it is its type
        LaunchedEffect(type) {
            fields = type?.let { engine.typeFields(it) } ?: emptyList()
            values = if (preset?.uri == type) preset?.fields ?: emptyMap() else emptyMap()
        }

        val open = picking
        if (open != null) {
            if (open.key.isEmpty()) Choices("Assign to", "You", { q -> engine.members().sortedBy { it.name.lowercase() }.filter { q.isEmpty() || it.name.contains(q, ignoreCase = true) } },
                current = { it == assignee?.id }, back = { picking = null }) { assignee = it; picking = null }
            else Choices(open.title, "None", { q -> engine.fieldChoices(open.key, q) }, current = { it == values[open.key]?.ref }, back = { picking = null }) { m ->
                values = if (m == null) values - open.key else values + (open.key to Value(ref = m.id, label = m.name)); picking = null
            }
            return@Sheet
        }

        val canAdd = (title.isNotBlank() || dictation.recording || dictation.transcribing) && working == null
        SheetBar("Quick Add", cancel = close, action = "Add", enabled = canAdd) { engine.scope.launch { add() } }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(Modifier.fillMaxSize()) {
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
                            GroupRow(last = i == all.size - 1, selected = type == t.uri, onClick = { type = t.uri }) {
                                Glyph(if (t.task == false) "doc" else "task", Modifier.size(20.dp), c.text)
                                Text(t.title, Modifier.weight(1f), color = c.text)
                                if (type == t.uri) Icon(Icons.Filled.Check, null, Modifier.size(20.dp), c.accent)
                            }
                        }
                    }
                }
                // Details: whom a task is for, and the chosen type's fields, a saved search's values already in them
                if (isTask || fields.isNotEmpty()) item("details") {
                    Group("Details") {
                        if (isTask) GroupRow(last = fields.isEmpty(), onClick = { picking = Field("", "Assign to", "member") }) {
                            Text("Assigned to", Modifier.weight(1f), color = c.text); Text(assignee?.name ?: "You", color = c.secondary)
                        }
                        fields.forEachIndexed { i, f -> FieldRow(f, values[f.key], last = i == fields.size - 1, set = { v -> values = if (v == null) values - f.key else values + (f.key to v) },
                            pick = { picking = f }, date = { dating = f }) }
                    }
                }
                item("image") {
                    Group("Image", footer = "Read with your ChatGPT account into a task or a note, with the image under it.") {
                        GroupRow(last = !hasClip, onClick = pickPhoto) { Icon(Icons.Outlined.Image, null, tint = c.text); Text("Process image from Photos", color = c.text) }
                        if (hasClip) GroupRow(last = true, onClick = { engine.platform.clipboardImage()?.let { engine.scope.launch { process(it) } } ?: run { failure = "The clipboard holds no image" } }) {
                            Icon(Icons.Outlined.ContentPaste, null, tint = c.text); Text("Process image from clipboard", color = c.text)
                        }
                    }
                }
            }
            working?.let { label ->
                Column(Modifier.align(Alignment.Center).background(c.card, RoundedCornerShape(14.dp)).padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    CircularProgressIndicator(color = c.secondary); Text(label, color = c.text)
                }
            }
        }
        failure?.let { Text(it, Modifier.fillMaxWidth().background(c.card).padding(8.dp), style = Type.footnote, color = c.secondary, textAlign = TextAlign.Center) }
    }

    dating?.let { f ->
        val now = values[f.key]?.ref?.let(Lists::parsePlainDate)?.let { (y, m, d) -> LocalDate(y, m, d).atStartOfDayIn(TimeZone.UTC).toEpochMilliseconds() }
        val state = rememberDatePickerState(initialSelectedDateMillis = now ?: kotlin.time.Clock.System.now().toEpochMilliseconds())
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
