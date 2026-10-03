package com.dreetje.orbital.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dreetje.orbital.Engine
import com.dreetje.orbital.Lists
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.time.Clock
import com.dreetje.orbital.Row as Node

// The Timeline as the desktop draws it (styles.css .node.tl): the time on the left, a marker on a thin rail that runs
// the length of the page, what happened to the right. Today's tasks, the free time and Upcoming meetings sit on the
// same rail above the days, each only when it has something in it.
@Composable
fun TimelineScreen(engine: Engine, modifier: Modifier = Modifier) {
    val c = Theme.colors
    val scope = rememberCoroutineScope()
    val still = engine.platform.reduceMotion
    val rows = engine.rows
    // connecting and the first read are one build (Building)
    val building = rows.isEmpty() && (engine.loading || engine.phase == Engine.Phase.Starting)
    val hasToday = rows.any { it.timeline?.today == true }
    val today = engine.shown(rows.firstOrNull { it.timeline?.today == true }?.children).filter { it.id !in engine.unpinned }
    val upcoming = engine.shown(rows.firstOrNull { it.timeline?.upcoming == true }?.children)
    val free = rows.firstOrNull { it.timeline?.free != null }?.timeline?.free
    val days = Lists.days(engine.shown(rows), Clock.System.now())
    // never the skeleton and the words on screen together: it goes in 0.15 s, then the rows come in
    val shown by animateFloatAsState(if (building) 0f else 1f, if (building || still) tween(0) else tween(250, delayMillis = 150))
    var refreshing by remember { mutableStateOf(false) }
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val timeWidth = remember(density) { maxOf(Rail.time, with(density) { measurer.measure("00:00", TimeStyle).size.width.toDp() } + 2.dp) }

    // the free time ends when the next meeting starts: read the page again then, so neither stays on screen past it.
    // On the engine's scope: the read changes free, which restarts this effect, and must not cancel the read itself.
    LaunchedEffect(free?.until) {
        val until = free?.until ?: return@LaunchedEffect
        delay(maxOf(1000L, (until - Clock.System.now().toEpochMilliseconds()).toLong()))
        engine.scope.launch { engine.refresh() }
    }

    androidx.compose.runtime.CompositionLocalProvider(LocalRailTime provides timeWidth) { Box(modifier) {
        PullToRefreshBox(refreshing, { scope.launch { refreshing = true; engine.refresh(); refreshing = false } }, Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize().alpha(shown), contentPadding = PaddingValues(bottom = 12.dp)) {
                val key = uniqueKeys()
                if (hasToday) {
                    // one stop on the rail: Now, the Today glyph, its words, the tasks hanging under them
                    item("today") { RailRow("Now", railTop = 24.dp, bottom = 0.dp, marker = { Marker("todayTasks", "new", false, still) }) { Text("Today's Tasks", style = Type.body, color = c.text) } }
                    if (today.isEmpty()) item("today-empty") {
                        RailRow("", top = 30.dp, bottom = 16.dp, marker = { Spacer(Modifier.height(1.dp)) }) {
                            Text("Nothing pinned to today. Long-press a task to pin it.", style = Type.subheadline, color = c.secondary)
                        }
                    } else taskLines(today, engine, "today", key)
                }
                // the free time, then one stop for the meetings still to come, each hanging under it like a task
                if (free != null) item("free") { FreeLine(free, if (hasToday) "" else "Now", if (upcoming.isEmpty()) 0.dp else 14.dp, still) }
                if (upcoming.isNotEmpty()) {
                    item("upcoming") { RailRow("", top = 14.dp, bottom = 0.dp, marker = { Marker("meeting", null, false, still) }) { Text("Upcoming meetings", style = Type.body, color = c.text) } }
                    upcoming.forEachIndexed { i, m -> item(key("up:" + m.id)) { Meeting(m, engine, if (i == 0) 28.dp else 14.dp, 0.dp) } }
                }
                // a line across under what is still to come, before what has happened
                if ((upcoming.isNotEmpty() || free != null) && days.isNotEmpty()) item("line") {
                    HorizontalDivider(Modifier.padding(start = 20.dp, end = 16.dp, top = 28.dp, bottom = 19.dp), color = c.separator)
                }
                days.forEach { (title, list) ->
                    item(key("day:$title")) { Heading(title) }
                    list.forEach { row ->
                        item(key("entry:" + row.id)) { Entry(row, engine) }
                        taskLines(row.children ?: emptyList(), engine, "entry:" + row.id, key)
                    }
                }
                // always, as the desktop has it: a quiet three days must not hide the days before them
                if (rows.isNotEmpty()) item("more") {
                    TextButton({ engine.scope.launch { engine.more() } }, Modifier.fillMaxWidth().padding(top = 6.dp), enabled = !engine.loading) {
                        Text(if (engine.loading) "Loading…" else "Show three more days", color = c.secondary)
                    }
                }
            }
        }
        // connecting and the first read are one build, and it fades as the rows land under it
        AnimatedVisibility(building, enter = fadeIn(tween(0)), exit = fadeOut(tween(if (still) 0 else 150))) { Building(still) }
        if (!building && rows.isEmpty()) {
            val error = engine.error
            if (error != null) Empty("Timeline didn't load", error, icon = Icons.Outlined.ErrorOutline)
            else Empty("Nothing yet", "Changes to your tasks, new Inbox tasks and your meetings show up here.", icon = Icons.Outlined.Schedule)
        }
        val error = engine.error
        if (error != null && rows.isNotEmpty()) {
            Text(error, Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(c.card).padding(8.dp), style = Type.footnote, color = c.secondary, textAlign = TextAlign.Center)
        }
    } }
}

// the rail's times: the footnote size, every digit as wide as the next so the column never jitters (monospacedDigit)
private val TimeStyle = Type.footnote.copy(fontFeatureSettings = "tnum")

// One stop on the rail. The line is drawn behind each row, through the markers' middle, so each row's piece meets the
// next and the rail reads as one line down the section.
@Composable
fun RailRow(
    label: String, // the time, or Now, or nothing
    modifier: Modifier = Modifier,
    railTop: Dp = 0.dp, // where the line starts: the first stop's starts at its marker, as the desktop's does
    top: Dp = 14.dp,
    bottom: Dp = 14.dp,
    marker: @Composable () -> Unit,
    content: @Composable BoxScope.() -> Unit,
) {
    val c = Theme.colors
    val four = with(LocalDensity.current) { 4.dp.roundToPx() }
    val time = LocalRailTime.current
    Row(
        modifier.fillMaxWidth()
            .drawBehind {
                val x = (Rail.inset + time + Rail.gap + Rail.marker / 2 - 0.5.dp).toPx() + 0.5f
                drawLine(c.separator, Offset(x, railTop.toPx()), Offset(x, size.height), 1.dp.toPx())
            }
            .padding(start = Rail.inset, end = 16.dp, top = top, bottom = bottom),
        horizontalArrangement = Arrangement.spacedBy(Rail.gap),
    ) {
        Text(label, Modifier.width(time).alignByBaseline(), style = TimeStyle, color = c.secondary, textAlign = TextAlign.End, maxLines = 1)
        // centred on the first line's lower-case letters, as the markers are on the desktop
        Box(Modifier.width(Rail.marker).alignBy { it.measuredHeight - four }, contentAlignment = Alignment.Center) { marker() }
        Box(Modifier.weight(1f).alignByBaseline(), content = content)
    }
}

// What happened: the sentence with its verb in bold, Tana's words about it under that, faces for a meeting, the tasks
// an Inbox line brought (rows of their own, TaskLines). A meeting with no write-up is drawn quiet (#214); a new one
// carries the blue dot.
@Composable
fun Entry(row: Node, engine: Engine) {
    val c = Theme.colors
    val zoom = LocalZoom.current
    val uri = row.timeline?.uri
    val quiet = row.tone == "faint"
    NodeMenu(uri, engine, Modifier.semantics { if (uri != null) role = Role.Button }, onClick = uri?.let { { zoom(it) } }) {
        RailRow(row.timeline?.time ?: "", bottom = if (engine.shown(row.children).isEmpty()) 14.dp else 0.dp,
            marker = { Marker(row.icon, row.tone, row.timeline?.recording == true, engine.platform.reduceMotion) }) {
            Sensitive(row.sensitive == true && !engine.reveal, Modifier.padding(end = if (row.unread == true) 18.dp else 0.dp)) {
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Words(row.styled(c, zoom), color = if (quiet) c.secondary else c.text)
                    for (line in listOfNotNull(row.timeline?.note, row.timeline?.change, row.timeline?.detail)) Words(line, style = Type.subheadline, color = c.secondary, maxLines = 3)
                    val people = row.people
                    if (!people.isNullOrEmpty()) Faces(people, modifier = Modifier.padding(top = 2.dp))
                }
            }
            if (row.unread == true) Box(Modifier.align(Alignment.TopEnd).offset(y = 7.dp).size(8.dp).background(c.accent, CircleShape).semantics { contentDescription = "New" })
        }
    }
}

// The tasks an entry lists, hanging under its words, each a row of its own on the rail, so a long press is about that
// task alone: as much room above the first as under the last, more between them. Keyed under their entry: one task
// can hang under two.
fun LazyListScope.taskLines(tasks: List<Node>, engine: Engine, parent: String, key: (String) -> String) {
    val shown = engine.shown(tasks)
    shown.forEachIndexed { i, task ->
        item(key("$parent/" + task.id)) { TaskLine(task, engine, if (i == 0) 30.dp else 16.dp, if (i == shown.size - 1) 16.dp else 0.dp) }
    }
}

@Composable
fun TaskLine(task: Node, engine: Engine, top: Dp, bottom: Dp) {
    val zoom = LocalZoom.current
    val four = with(LocalDensity.current) { 4.dp.roundToPx() }
    RailRow("", top = top, bottom = bottom, marker = { Spacer(Modifier.height(1.dp)) }) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            TaskBox(task, engine, Modifier.alignBy { it.measuredHeight - four })
            NodeMenu(task.id, engine, Modifier.weight(1f).alignByBaseline(), task = engine.state(task), assignees = task.assignees, onClick = { zoom(task.id) }) {
                TaskWords(task, engine)
            }
        }
    }
}

// A task's words, struck and grey once done; in the chosen language when they are in another (the translate glyph
// says so, after them, or on the row's grey line where it has one: globe false)
@Composable
fun TaskWords(row: Node, engine: Engine, globe: Boolean = true, modifier: Modifier = Modifier) {
    val c = Theme.colors
    val done = engine.state(row) == "closed"
    val (words, from) = engine.translator.words(row.words, row.sensitive == true)
    val text = buildAnnotatedString {
        append(words)
        if (from != null && globe) { append("  "); appendInlineContent("lang", "translated") }
    }
    Sensitive(row.sensitive == true && !engine.reveal, modifier) {
        Words(text, style = Type.body.copy(textDecoration = if (done) TextDecoration.LineThrough else null), color = if (done) c.secondary else c.text,
            inline = mapOf("lang" to InlineTextContent(Placeholder(14.sp, 14.sp, PlaceholderVerticalAlign.TextCenter)) { Glyph("language", Modifier.fillMaxSize(), c.tertiary, "Translated from " + from) }))
    }
}

// A meeting still to come today, under Upcoming meetings: its glyph, its name, and a grey line with when it is and who
// else is on it
@Composable
fun Meeting(row: Node, engine: Engine, top: Dp, bottom: Dp) {
    val c = Theme.colors
    val zoom = LocalZoom.current
    val three = with(LocalDensity.current) { 3.dp.roundToPx() }
    NodeMenu(row.id, engine, Modifier.semantics { role = Role.Button }, onClick = { zoom(row.id) }) {
        RailRow("", top = top, bottom = bottom, marker = { Spacer(Modifier.height(1.dp)) }) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                // a calendar, or a route for Travel (main/timeline.js meetingIcon)
                Glyph(if (row.icon == "pinRoute") "pinRoute" else "calendar", Modifier.size(18.dp).alignBy { it.measuredHeight - three }, c.secondary)
                Sensitive(row.sensitive == true && !engine.reveal, Modifier.weight(1f).alignByBaseline()) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Words(engine.translator.words(row.words, row.sensitive == true).first)
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Words(row.subtext ?: "", style = Type.subheadline, color = c.secondary) // when it is: the engine's words
                            val people = row.people
                            if (!people.isNullOrEmpty()) { Text("·", color = c.secondary); Faces(people, names = false) }
                        }
                    }
                }
            }
        }
    }
}

// The free time before the next meeting, counted down while it shows
@Composable
fun FreeLine(free: Node.Free, time: String, bottom: Dp, still: Boolean) {
    val c = Theme.colors
    var now by remember { mutableStateOf(Clock.System.now()) }
    LaunchedEffect(Unit) { while (true) { delay(15_000); now = Clock.System.now() } }
    val (before, bold, after) = Lists.free(free, now.toEpochMilliseconds().toDouble())
    RailRow(time, bottom = bottom, marker = { Marker("free", "new", false, still) }) {
        Text(buildAnnotatedString { append(before); withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(bold) }; append(after) }, style = Type.body, color = c.secondary)
    }
}
