package com.dreetje.orbital.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.MoveToInbox
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
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
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.layout
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dreetje.orbital.Engine
import com.dreetje.orbital.Lists
import com.dreetje.orbital.Row as Node
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// The iPhone's ios/Orbital/Timeline.swift: the Timeline and its rail, and the parts every list shares (a task's box,
// faces, the long-press menu)

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
    val days = Lists.days(engine.shown(rows), engine.now())
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
        delay(maxOf(1000L, (until - engine.now().toEpochMilliseconds()).toLong()))
        engine.scope.launch { engine.refresh() }
    }

    androidx.compose.runtime.CompositionLocalProvider(LocalRailTime provides timeWidth) { Box(modifier) {
        PullToRefreshBox(refreshing, { scope.launch { refreshing = true; engine.refresh(); refreshing = false } }, Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize().alpha(shown), contentPadding = PaddingValues(bottom = 12.dp + LocalBottomInset.current)) {
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
                if (free != null) item("free") { FreeLine(free, if (hasToday) "" else "Now", if (upcoming.isEmpty()) 0.dp else 14.dp, engine) }
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
                    // the saved Timeline is on screen before Tana connects, or when it cannot be reached: more days wait for
                    // it, greyed and saying why
                    TextButton({ engine.scope.launch { engine.more() } }, Modifier.fillMaxWidth().padding(top = 6.dp), enabled = !engine.loading && engine.phase == Engine.Phase.Ready) {
                        val label = when {
                            engine.loading || engine.phase == Engine.Phase.Starting -> "Loading…"
                            engine.phase == Engine.Phase.Ready -> "Show three more days"
                            else -> "Can't reach Tana"
                        }
                        Text(label, color = c.secondary)
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
            Notice(error, Modifier.align(Alignment.BottomCenter).padding(bottom = LocalBottomInset.current))
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
        Box(onBaseline(4.dp, Modifier.width(Rail.marker)), contentAlignment = Alignment.Center) { marker() }
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
    // no long press (null): an entry is something that happened ("Priya completed …"), not a task; its tasks have their own
    NodeMenu(null, engine, Modifier.semantics { if (uri != null) role = Role.Button }, onClick = uri?.let { { zoom(it) } }) {
        RailRow(row.timeline?.time ?: "", bottom = if (engine.shown(row.children).isEmpty()) 14.dp else 0.dp,
            marker = { Marker(row.icon, row.tone, row.timeline?.recording == true, engine.platform.reduceMotion) }) {
            Sensitive(row, engine.reveal, Modifier.padding(end = if (row.unread == true) 18.dp else 0.dp)) {
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
    RailRow("", top = top, bottom = bottom, marker = { Spacer(Modifier.height(1.dp)) }) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            TaskBox(task, engine, onBaseline(4.dp))
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
    Sensitive(row, engine.reveal, modifier) {
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
    // no long press (null): a meeting is not a task (the Timeline's long press is for its tasks alone)
    NodeMenu(null, engine, Modifier.semantics { role = Role.Button }, onClick = { zoom(row.id) }) {
        RailRow("", top = top, bottom = bottom, marker = { Spacer(Modifier.height(1.dp)) }) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                // a calendar, or a route for Travel (main/timeline.js meetingIcon)
                Glyph(if (row.icon == "pinRoute") "pinRoute" else "calendar", onBaseline(3.dp, Modifier.size(18.dp)), c.secondary)
                Sensitive(row, engine.reveal, Modifier.weight(1f).alignByBaseline()) {
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
fun FreeLine(free: Node.Free, time: String, bottom: Dp, engine: Engine) {
    val c = Theme.colors
    var now by remember { mutableStateOf(engine.now()) }
    LaunchedEffect(Unit) { while (true) { delay(15_000); now = engine.now() } }
    val (before, bold, after) = Lists.free(free, now.toEpochMilliseconds().toDouble())
    RailRow(time, bottom = bottom, marker = { Marker("free", "new", false, engine.platform.reduceMotion) }) {
        Text(buildAnnotatedString { append(before); withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(bold) }; append(after) }, style = Type.body, color = c.secondary)
    }
}

// The desktop's box (styles.css .check): a grey rounded square, green with a white tick once done, a dashed outline for
// an Inbox task (its first tap accepts it)
@Composable
fun CheckBox(state: String, still: Boolean, modifier: Modifier = Modifier) {
    val c = Theme.colors
    // the iPhone's .animation(.snappy, value: state): the tick springs in, a touch past its size and back
    val tick by animateFloatAsState(if (state == "closed") 1f else 0f, if (still) tween(0) else snappy())
    Canvas(modifier.size(20.dp)) {
        val r = CornerRadius(5.5.dp.toPx())
        when (state) {
            "proposed" -> {
                val w = 1.2.dp.toPx()
                drawRoundRect(c.checkInbox, Offset(w / 2, w / 2), size.copy(size.width - w, size.height - w), r,
                    style = Stroke(w, pathEffect = PathEffect.dashPathEffect(floatArrayOf(2.6.dp.toPx(), 2.4.dp.toPx()))))
            }
            "closed" -> drawRoundRect(c.checkOn, cornerRadius = r)
            else -> drawRoundRect(c.checkOff, cornerRadius = r)
        }
        if (tick > 0f) {
            // the desktop's tick (M4 8.7 l3.3 3.3 6.9-6.9 in an 18 box), drawn to this box, scaling in
            val s = size.width / 18f
            val p = Path().apply { moveTo(4 * s, 8.7f * s); lineTo(7.3f * s, 12 * s); lineTo(14.2f * s, 5.1f * s) }
            scaleAround(tick) { drawPath(p, Color.White, style = Stroke(2.2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)) }
        }
    }
}

private inline fun androidx.compose.ui.graphics.drawscope.DrawScope.scaleAround(k: Float, block: androidx.compose.ui.graphics.drawscope.DrawScope.() -> Unit) =
    drawContext.transform.let { t -> t.scale(k, k, center); block(); t.scale(1 / k, 1 / k, center) }

// A task's box: a tap ticks it off or back on (Engine.toggle, the desktop's rule), with the success haptic as the tick
// lands, not when Tana answers; the words beside it open the task. TalkBack reads its words and its state. The write
// runs on the engine's scope, as the iPhone's Task does, so a row leaving the list (a tick that moves it) never cancels
// its own write. The box is drawn text-sized and takes a finger-sized tap around it without moving anything, as the
// iPhone's .padding(10).contentShape(Rectangle()).padding(-10) does: 48 dp, Android's touch target.
@Composable
fun TaskBox(task: Node, engine: Engine, modifier: Modifier = Modifier) {
    val state = engine.state(task)
    val haptic = LocalHapticFeedback.current
    val hidden = task.sensitive == true && !engine.reveal
    fun toggle() {
        if (!engine.demo && state != "proposed" && state != "closed") haptic.performHapticFeedback(HapticFeedbackType.Confirm)
        engine.scope.launch { engine.toggle(task) }
    }
    Box(modifier
        .layout { m, _ ->
            val target = m.measure(Constraints.fixed(48.dp.roundToPx(), 48.dp.roundToPx()))
            val box = 20.dp.roundToPx()
            layout(box, box) { target.place((box - target.width) / 2, (box - target.height) / 2) }
        }
        .clearAndSetSemantics {
            contentDescription = if (hidden) "Sensitive task" else task.words
            stateDescription = when (state) { "closed" -> "Completed"; "proposed" -> "In your Inbox"; else -> "Not completed" }
            role = androidx.compose.ui.semantics.Role.Checkbox
            onClick("Ticks the task off, or back on") { toggle(); true }
        }
        .clickable(remember { MutableInteractionSource() }, null) { toggle() }, contentAlignment = Alignment.Center) {
        CheckBox(state, engine.platform.reduceMotion)
    }
}

// The marker in the gutter, as the desktop's rail draws it (main/timeline.js ICON, styles.css .tl-*): finished work is
// a green disc with a white check, a new task and a meeting with no write-up are quieter, a meeting under way is blue
@Composable
fun Marker(icon: String?, tone: String?, now: Boolean, still: Boolean, modifier: Modifier = Modifier) {
    val c = Theme.colors
    Box(modifier.size(22.dp).clearAndSetSemantics {}, contentAlignment = Alignment.Center) {
        if (tone == "done") {
            Box(Modifier.size(20.dp).background(c.done, CircleShape), contentAlignment = Alignment.Center) {
                Glyph("applyDone", Modifier.size(12.dp), Color.White)
            }
            return@Box
        }
        if (now) Pulse(still)
        Box(Modifier.size(24.dp).background(c.page, CircleShape)) // the rail passes behind the glyph, as on the desktop
        Glyph(Glyphs.marker(icon), Modifier.size(20.dp), if (now) c.accent else if (tone == "new" || tone == "faint") c.tertiary else c.secondary)
    }
}

// The desktop's recording ring (styles.css .tl-recording, rec-pulse): blue, swelling from behind the marker and
// fading, every 1.4 s; with animations off a still blue disc
@Composable
fun Pulse(still: Boolean) {
    val c = Theme.colors
    if (still) { Box(Modifier.size(24.dp).alpha(0.25f).background(c.accent, CircleShape)); return }
    val t by rememberInfiniteTransition().animateFloat(0f, 1f, infiniteRepeatable(tween(1400, easing = LinearEasing), RepeatMode.Restart))
    Box(Modifier.size(24.dp).scale(1f + 1.2f * t).alpha(0.45f * (1 - t)).background(c.accent, CircleShape))
}

// People as faces (#461): initials in grey circles, overlapping, four at most; the names follow when there are few.
// Each circle's ring is the page's colour and sits on its edge, half outside it, as SwiftUI's stroke overlay does, so
// each face cuts into the one before; the initials are 10 whatever the font size, as the iPhone's .system(size: 10).
@Composable
fun Faces(people: List<Node.Person>, names: Boolean = true, modifier: Modifier = Modifier) {
    val c = Theme.colors
    val hidden = LocalHidden.current // under a sensitive mark: the names barred, no circles
    val ten = with(LocalDensity.current) { 10.dp.toSp() }
    Row(modifier.semantics(mergeDescendants = true) {}.clearAndSetSemantics { contentDescription = if (hidden) SENSITIVE_LABEL else people.joinToString(", ") { it.name } },
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        if (!hidden) Row(horizontalArrangement = Arrangement.spacedBy((-4).dp)) {
            for (p in people.take(4)) {
                Box(Modifier.size(24.dp).drawBehind { drawCircle(c.face); drawCircle(c.page, style = Stroke(1.5.dp.toPx())) }, contentAlignment = Alignment.Center) {
                    Text(initials(p.name), color = c.secondary, fontSize = ten, lineHeight = ten, fontWeight = FontWeight.SemiBold, maxLines = 1)
                }
            }
        }
        if (names) Words(if (people.size <= 2) people.joinToString(", ") { it.name } else "${people.size} people", style = Type.subheadline, color = c.secondary, maxLines = 1)
    }
}

fun initials(name: String) = name.split(" ").filter { it.isNotEmpty() }.take(2).map { it.first().uppercaseChar() }.joinToString("")

// Long press on a node: assign it, move it back to the Inbox, pin it to today or take it off, mark it sensitive or
// not, or delete it to Tana's trash where you may (Engine.pin, markSensitive, remove); done reads the page again.
// task: the task's state, which offers Assign to … and, out of the Inbox, Move to Inbox. Each runs on the engine's
// scope: Delete and Remove Pin take the row away, which must not cancel them (and their rollback) half way.
@Composable
fun NodeMenu(
    id: String?,
    engine: Engine,
    modifier: Modifier = Modifier,
    task: String? = null,
    assignees: List<String>? = null,
    then: suspend () -> Unit = {},
    onClick: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val haptic = LocalHapticFeedback.current
    val node = id?.takeIf { it.startsWith("tana:") }
    Box(modifier.combinedClickable(
        enabled = onClick != null || node != null,
        onClick = { onClick?.invoke() },
        onLongClickLabel = if (node != null) "Actions" else null,
        onLongClick = if (node != null) ({ haptic.performHapticFeedback(HapticFeedbackType.LongPress); open = true }) else null,
    )) {
        content()
        if (node != null) DropdownMenu(open, { open = false }) {
            val run: (suspend () -> Unit) -> () -> Unit = { act -> { open = false; engine.scope.launch { act() } } }
            // a task's people, with your Dot on top (Agents.kt); a note has only your Dot to go to
            if (task != null || (handable(node) && engine.agentsOn.isNotEmpty()))
                MenuItem("Assign to …", Icons.Outlined.AccountCircle, onClick = run { engine.assigning = Engine.Assigning(node, assignees, then, people = task != null) })
            if (task != null && task != "proposed") MenuItem("Move to Inbox", Icons.Outlined.MoveToInbox, onClick = run { engine.moveToInbox(node); then() })
            val pinned = node in engine.pinned
            val secret = node in engine.sensitiveIds
            // pinned to any day: only taking the pin off
            MenuItem(if (pinned) "Remove Pin" else "Pin to Today", Icons.Outlined.PushPin, onClick = run { engine.pin(node, !pinned); then() })
            MenuItem(if (secret) "Not Sensitive" else "Mark as Sensitive", if (secret) Icons.Outlined.Visibility else Icons.Outlined.VisibilityOff, onClick = run { engine.markSensitive(node, !secret); then() })
            HorizontalDivider()
            MenuItem("Delete", Icons.Outlined.Delete, red = true, onClick = run { if (engine.remove(node)) then() })
        }
    }
}

@Composable
private fun MenuItem(title: String, icon: androidx.compose.ui.graphics.vector.ImageVector, red: Boolean = false, onClick: () -> Unit) {
    val color = if (red) Theme.colors.danger else Theme.colors.text
    DropdownMenuItem(text = { Text(title, color = color) }, onClick = onClick, leadingIcon = { Icon(icon, null, tint = color) })
}

// A section's heading: a row of its own between two stretches of rail, its words in the middle of the gap
@Composable
fun Heading(title: String, modifier: Modifier = Modifier) {
    Text(title, modifier.padding(start = 20.dp, end = 16.dp, top = 11.dp, bottom = 17.dp).semantics { heading() },
        style = Type.headline, color = Theme.colors.secondary)
}
