package com.dreetje.orbital.ui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.MoveToInbox
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.dreetje.orbital.Engine
import com.dreetje.orbital.Row as Node
import kotlinx.coroutines.launch

// The desktop's box (styles.css .check): a grey rounded square, green with a white tick once done, a dashed outline for
// an Inbox task (its first tap accepts it)
@Composable
fun CheckBox(state: String, still: Boolean, modifier: Modifier = Modifier) {
    val c = Theme.colors
    val tick by animateFloatAsState(if (state == "closed") 1f else 0f, if (still) tween(0) else tween(220, easing = FastOutSlowInEasing))
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

// A task's box: a tap ticks it off or back on (Engine.toggle, the desktop's rule), with the success haptic; the words
// beside it open the task. TalkBack reads its words and its state. The write runs on the engine's scope, as the
// iPhone's Task does, so a row leaving the list (a tick that moves it) never cancels its own write.
@Composable
fun TaskBox(task: Node, engine: Engine, modifier: Modifier = Modifier) {
    val state = engine.state(task)
    val haptic = LocalHapticFeedback.current
    val hidden = task.sensitive == true && !engine.reveal
    CheckBox(state, engine.platform.reduceMotion, modifier
        .semantics(mergeDescendants = true) {}
        .clearAndSetSemantics {
            contentDescription = if (hidden) "Sensitive task" else task.words
            stateDescription = when (state) { "closed" -> "Completed"; "proposed" -> "In your Inbox"; else -> "Not completed" }
            role = androidx.compose.ui.semantics.Role.Checkbox
            onClick("Ticks the task off, or back on") { engine.scope.launch { engine.toggle(task) }; true }
        }
        .combinedClickable(onClick = {
            engine.scope.launch {
                engine.toggle(task)
                if (engine.states[task.id] == "closed") haptic.performHapticFeedback(HapticFeedbackType.Confirm) // your own tick, not a change read from Tana
            }
        }))
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
        val glyph = when (icon) {
            "tlAccepted", "tlLater", "tlInbox", "tlNew", "updated", "robot", "tana", "free", "todayTasks", "pinRoute" -> icon
            else -> "calendar" // a meeting (the desktop draws its type's glyph, calendar)
        }
        Glyph(glyph, Modifier.size(20.dp), if (now) c.accent else if (tone == "new" || tone == "faint") c.tertiary else c.secondary)
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
    Row(modifier.semantics(mergeDescendants = true) {}.clearAndSetSemantics { contentDescription = if (hidden) "Sensitive, shake to show" else people.joinToString(", ") { it.name } },
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
            if (task != null) MenuItem("Assign to …", Icons.Outlined.AccountCircle, onClick = run { engine.assigning = Engine.Assigning(node, assignees, then) })
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
