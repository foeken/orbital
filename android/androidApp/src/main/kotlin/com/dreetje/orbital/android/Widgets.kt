package com.dreetje.orbital.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.action.Action
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.LazyListScope
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.appwidget.updateAll
import androidx.glance.background
import androidx.glance.currentState
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxHeight
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextDecoration
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.dreetje.orbital.Glimpse
import com.dreetje.orbital.Lists
import com.dreetje.orbital.Row
import com.dreetje.orbital.Times
import com.dreetje.orbital.json
import com.dreetje.orbital.kindOf
import com.dreetje.orbital.ui.Colors
import com.dreetje.orbital.ui.Dark
import com.dreetje.orbital.ui.Glyphs
import com.dreetje.orbital.ui.Light
import com.dreetje.orbital.ui.glyphBitmap
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlin.time.Clock
import kotlin.time.Instant
import androidx.glance.color.ColorProvider as DayNight

// The iPhone's ios/Widgets: two widgets over what the app last read (Glimpse, kept after every read; a widget cannot run
// the engine). On the home screen, Today's Tasks across the widget's whole width; on the Galaxy Z Flip's cover screen,
// the Timeline on its rail, scrolled as the app's is, a meeting's documents opened in place by its chevron. A row
// opens its node in the app, + opens Quick Add, the title the Timeline.
object Widgets {
    private const val KEY = "glimpse"
    private val glimpse = MutableStateFlow<Glimpse?>(null)
    private var loaded = false

    fun glimpse(context: Context): StateFlow<Glimpse?> = synchronized(this) {
        if (!loaded) { loaded = true; glimpse.value = Files(context).get(KEY)?.let { runCatching { json.decodeFromString<Glimpse>(it) }.getOrNull() } }
        glimpse
    }

    // what the app read, kept and drawn; null once signed out, so nothing of the account stays on a screen
    suspend fun keep(context: Context, read: Glimpse?) {
        Files(context).set(KEY, read?.let { json.encodeToString(it) })
        synchronized(this) { loaded = true; glimpse.value = read }
        TodayWidget().updateAll(context)
        TimelineWidget().updateAll(context)
    }
}

class TodayWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) = provideContent {
        val glimpse by remember { Widgets.glimpse(context) }.collectAsState()
        TodayTasks(glimpse)
    }
}

class TimelineWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) = provideContent {
        val glimpse by remember { Widgets.glimpse(context) }.collectAsState()
        RailTimeline(glimpse)
    }
}

class TodayWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TodayWidget()
}

class TimelineWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TimelineWidget()
}

// A meeting's chevron: its documents shown under it in this widget, or hidden again (kept per widget, Glance's state)
class ShowDocuments : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val id = parameters[MEETING] ?: return
        updateAppWidgetState(context, glanceId) { it[OPEN] = it[OPEN].orEmpty().let { open -> if (id in open) open - id else open + id } }
        TimelineWidget().update(context, glanceId)
    }

    companion object {
        val MEETING = ActionParameters.Key<String>("meeting")
        val OPEN = stringSetPreferencesKey("open")
    }
}

// Today's Tasks, each a whole line: its box and its words; a tap opens the task
@Composable
internal fun TodayTasks(glimpse: Glimpse?) = Frame("Today's Tasks") {
    val today = glimpse?.today
    when {
        glimpse == null -> Note("Open Orbital to see today's tasks here.", GlanceModifier.clickable(openApp(LocalContext.current)))
        today.isNullOrEmpty() -> Note("Nothing pinned to today.")
        else -> LazyColumn {
            items(today) { task ->
                Row(GlanceModifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 9.dp).clickable(open(LocalContext.current, task.id)), verticalAlignment = Alignment.CenterVertically) {
                    TaskBox(task.stateType)
                    Spacer(GlanceModifier.width(12.dp))
                    Words(task)
                }
            }
        }
    }
}

// The Timeline as the app draws it (TimelineScreen): Now and Today's Tasks, the free time, Upcoming meetings, a line,
// then what happened under each day, the tasks an entry brought hanging under it, all on one rail, scrolled
@Composable
internal fun RailTimeline(glimpse: Glimpse?) = Frame("Timeline") {
    if (glimpse == null) return@Frame Note("Open Orbital to see your Timeline here.", GlanceModifier.clickable(openApp(LocalContext.current)))
    val context = LocalContext.current
    val now = Clock.System.now()
    val open = currentState(ShowDocuments.OPEN).orEmpty()
    val scale = context.resources.configuration.fontScale
    val line = (14 + 18 * scale).dp // one line a stop, at this phone's font size
    val time = (2 + 34 * scale).dp // the time column, as wide as "00:00"
    val today = glimpse.today
    val free = glimpse.free(now)
    val upcoming = glimpse.upcoming(now)
    val days = Lists.days(glimpse.rows, now)
    if (today == null && free == null && upcoming.isEmpty() && days.isEmpty()) return@Frame Note("Nothing yet. Changes to your tasks, new Inbox tasks and your meetings show up here.")
    LazyColumn {
        var first = true
        fun LazyListScope.stop(label: String, opens: Action, marker: (@Composable () -> Unit)?, toggle: Action? = null, opened: Boolean = false, content: @Composable () -> Unit) {
            val top = first
            first = false
            item { RailRow(label, opens, line, time, top, marker, toggle, opened, content) }
        }
        fun LazyListScope.meeting(m: Row, label: String, marker: (@Composable () -> Unit)?, content: @Composable () -> Unit) {
            val docs = glimpse.docs[m.timeline?.uri ?: m.id].orEmpty()
            val id = m.timeline?.uri ?: m.id
            stop(label, open(context, id), marker, docs.takeIf { it.isNotEmpty() }?.let { actionRunCallback<ShowDocuments>(actionParametersOf(ShowDocuments.MEETING to id)) }, id in open, content)
            if (id in open) docs.forEach { d -> stop("", open(context, d.id), null) { Row(verticalAlignment = Alignment.CenterVertically) { Glyph(Glyphs.ofUri(d.id), 16.dp, paint { it.secondary }); Spacer(GlanceModifier.width(8.dp)); Words(d) } } }
        }
        fun LazyListScope.tasks(list: List<Row>) = list.forEach { t ->
            stop("", open(context, t.id), null) { Row(verticalAlignment = Alignment.CenterVertically) { TaskBox(t.stateType); Spacer(GlanceModifier.width(10.dp)); Words(t) } }
        }
        if (today != null) {
            stop("Now", openApp(context), { Marker("todayTasks", "new") }) { Words("Today's Tasks") }
            if (today.isEmpty()) stop("", openApp(context), null) { Words("Nothing pinned to today.", quiet = true) } else tasks(today)
        }
        if (free != null) stop(if (today != null) "" else "Now", openApp(context), { Marker("free", "new") }) { Words("No meetings until " + Times.hm(Instant.fromEpochMilliseconds(free.until.toLong())), quiet = true) }
        if (upcoming.isNotEmpty()) {
            stop("", openApp(context), { Marker("calendar", null) }) { Words("Upcoming meetings") }
            upcoming.forEach { m ->
                meeting(m, m.subtext?.substringBefore("–") ?: "", null) {
                    Row(verticalAlignment = Alignment.CenterVertically) { Glyph(if (m.icon == "pinRoute") "pinRoute" else "calendar", 16.dp, paint { it.secondary }); Spacer(GlanceModifier.width(8.dp)); Words(m) }
                }
            }
        }
        if ((today != null || free != null || upcoming.isNotEmpty()) && days.isNotEmpty()) item { Divider() }
        days.forEach { (title, entries) ->
            item { Heading(title, line) }
            entries.forEach { e ->
                val marker: @Composable () -> Unit = { Marker(Glyphs.marker(e.icon), if (e.timeline?.recording == true) "live" else e.tone) }
                val label = e.timeline?.time ?: ""
                if (kindOf(e.timeline?.uri ?: "") == "event") meeting(e, label, marker) { Words(e, quiet = e.tone == "faint") }
                else stop(label, e.timeline?.uri?.let { open(context, it) } ?: openApp(context), marker) { Words(e, quiet = e.tone == "faint") }
                tasks(e.children.orEmpty())
            }
        }
    }
}

// the widget: its bar (the title opens the app, + opens Quick Add), then what it shows, in the app's colours
@Composable
private fun Frame(title: String, content: @Composable () -> Unit) {
    val context = LocalContext.current
    Column(GlanceModifier.fillMaxSize().appWidgetBackground().cornerRadius(android.R.dimen.system_app_widget_background_radius).background(paint { it.page })) {
        Row(GlanceModifier.fillMaxWidth().height(48.dp).padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(title, GlanceModifier.defaultWeight().clickable(openApp(context)), style = TextStyle(paint { it.text }, 16.sp, FontWeight.Medium), maxLines = 1)
            Box(GlanceModifier.size(44.dp).clickable(openApp(context, "add") { putExtra("add", true) }), contentAlignment = Alignment.Center) {
                Image(ImageProvider(R.drawable.add), "Quick Add Task", GlanceModifier.size(22.dp), colorFilter = ColorFilter.tint(paint { it.text }))
            }
        }
        content()
    }
}

// One stop on the rail: the time, the marker on a line through the markers' middle, what happened; a meeting with
// documents ends in its chevron
@Composable
private fun RailRow(label: String, opens: Action, height: Dp, time: Dp, first: Boolean, marker: (@Composable () -> Unit)?, toggle: Action?, opened: Boolean, content: @Composable () -> Unit) {
    Row(GlanceModifier.fillMaxWidth().height(height).padding(start = 12.dp, end = 4.dp).clickable(opens), verticalAlignment = Alignment.CenterVertically) {
        Text(label, GlanceModifier.width(time), style = TextStyle(paint { it.secondary }, 13.sp, textAlign = TextAlign.End), maxLines = 1)
        Spacer(GlanceModifier.width(10.dp))
        Box(GlanceModifier.width(24.dp).fillMaxHeight(), contentAlignment = Alignment.Center) {
            Box(GlanceModifier.fillMaxHeight().padding(top = if (first) height / 2 else 0.dp)) { Box(GlanceModifier.width(1.dp).fillMaxHeight().background(paint { it.separator })) {} }
            marker?.invoke()
        }
        Spacer(GlanceModifier.width(10.dp))
        Box(GlanceModifier.defaultWeight()) { content() }
        if (toggle != null) Box(GlanceModifier.size(40.dp).clickable(toggle).semantics { contentDescription = if (opened) "Hide documents" else "Show documents" }, contentAlignment = Alignment.Center) {
            Image(ImageProvider(if (opened) R.drawable.expand_less else R.drawable.expand_more), null, GlanceModifier.size(20.dp), colorFilter = ColorFilter.tint(paint { it.secondary }))
        } else Spacer(GlanceModifier.width(10.dp))
    }
}

// the app's colours, light and dark (Theme.kt), as RemoteViews take them
private fun paint(pick: (Colors) -> Color): ColorProvider = DayNight(pick(Light), pick(Dark))
private val white = DayNight(Color.White, Color.White)

// the rail's marker (Timeline.kt Marker): finished work a green disc with a white check; a new task or a meeting with no
// write-up quieter; one being recorded blue
@Composable
private fun Marker(glyph: String, tone: String?) {
    if (tone == "done") Box(GlanceModifier.size(20.dp).cornerRadius(10.dp).background(paint { it.done }), contentAlignment = Alignment.Center) { Glyph("applyDone", 12.dp, white) }
    else Box(GlanceModifier.size(22.dp).cornerRadius(11.dp).background(paint { it.page }), contentAlignment = Alignment.Center) { // the rail passes behind it
        Glyph(glyph, 18.dp, paint { if (tone == "live") it.accent else if (tone == "new" || tone == "faint") it.tertiary else it.secondary })
    }
}

// the app's box (Timeline.kt CheckBox): grey, green with a tick once done, an outline for an Inbox task
@Composable
private fun TaskBox(state: String?) {
    val box = GlanceModifier.size(18.dp).cornerRadius(5.dp)
    when (state) {
        "closed" -> Box(box.background(paint { it.checkOn }), contentAlignment = Alignment.Center) { Glyph("applyDone", 11.dp, white) }
        "proposed" -> Box(box.background(paint { it.checkInbox }).padding(1.2.dp)) { Box(GlanceModifier.fillMaxSize().cornerRadius(4.dp).background(paint { it.page })) {} }
        else -> Box(box.background(paint { it.checkOff })) {}
    }
}

@Composable
private fun Glyph(name: String, size: Dp, tint: ColorProvider) =
    Image(ImageProvider(glyphBitmap(name, 72)), null, GlanceModifier.size(size), colorFilter = ColorFilter.tint(tint))

@Composable
private fun Words(words: String, quiet: Boolean = false, done: Boolean = false) =
    Text(words, style = TextStyle(paint { if (quiet || done) it.secondary else it.text }, 14.sp, textDecoration = if (done) TextDecoration.LineThrough else null), maxLines = 1)

// a row's words, a done task struck; a sensitive one a bar, as the app draws it until a shake (its words are never in a
// Glimpse the app kept)
@Composable
private fun Words(row: Row, quiet: Boolean = false) {
    if (row.sensitive != true) return Words(row.segments?.joinToString("") { it.text ?: it.mention?.label ?: "" }?.takeIf { it.isNotBlank() } ?: row.words, quiet, done = row.stateType == "closed")
    Box(GlanceModifier.width((72 + (row.id.hashCode() and 63)).dp).height(10.dp).cornerRadius(3.dp).background(paint { it.redacted }).semantics { contentDescription = "Sensitive" }) {}
}

@Composable
private fun Heading(title: String, height: Dp) =
    Text(title, GlanceModifier.fillMaxWidth().height(height).padding(start = 20.dp, top = 6.dp), style = TextStyle(paint { it.secondary }, 14.sp, FontWeight.Medium), maxLines = 1)

@Composable
private fun Divider() =
    Box(GlanceModifier.fillMaxWidth().height(17.dp).padding(start = 20.dp, end = 16.dp, top = 8.dp, bottom = 8.dp)) { Box(GlanceModifier.fillMaxSize().background(paint { it.separator })) {} }

@Composable
private fun Note(words: String, modifier: GlanceModifier = GlanceModifier) =
    Text(words, modifier.padding(horizontal = 16.dp, vertical = 4.dp), style = TextStyle(paint { it.secondary }, 14.sp))

// a node opened in the app (MainActivity's zoom), or the app itself; each intent made unique by what it opens, as a
// pending intent ignores the extras
private fun open(context: Context, id: String) = openApp(context, id) { putExtra("zoom", id) }
private fun openApp(context: Context, what: String = "timeline", extras: Intent.() -> Unit = {}): Action =
    actionStartActivity(Intent(context, MainActivity::class.java).setData(Uri.fromParts("orbital", what, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).apply(extras))
