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
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.action.Action
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.LazyListScope
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.updateAll
import androidx.glance.background
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
import com.dreetje.orbital.Row
import com.dreetje.orbital.Times
import com.dreetje.orbital.asTask
import com.dreetje.orbital.json
import com.dreetje.orbital.kindOf
import com.dreetje.orbital.ui.Glyphs
import com.dreetje.orbital.ui.glyphBitmap
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlin.time.Clock
import kotlin.time.Instant

// The iPhone's ios/Widgets: three widgets over what the app last read (Glimpse, kept after every read; a widget cannot
// run the engine), each on the home screen, the lock screen and a Galaxy Z Flip's cover screen alike (res/xml; any phone,
// docs/ANDROID.md Review guidelines): Today's Tasks across the widget's whole width, and the Timeline on its rail in two,
// scrolled as the app's is: what is ahead today (today's tasks and the meetings to come) and Activity, what happened. A row
// opens its node in the app, + opens Quick Add, the title the Timeline; a task's box opens the app too, which ticks it
// and writes it to Tana at once (orbital:check:<id>, ui/Shell.kt Link), as the iPhone's does.
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
        AheadWidget().updateAll(context)
        ActivityWidget().updateAll(context)
    }
}

class TodayWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) = provideContent {
        val glimpse by remember { Widgets.glimpse(context) }.collectAsState()
        TodayTasks(glimpse)
    }
}

class AheadWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) = provideContent {
        val glimpse by remember { Widgets.glimpse(context) }.collectAsState()
        RailTimeline(glimpse, Part.Ahead)
    }
}

class ActivityWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) = provideContent {
        val glimpse by remember { Widgets.glimpse(context) }.collectAsState()
        RailTimeline(glimpse, Part.Activity)
    }
}

class TodayWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TodayWidget()
}

class AheadWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = AheadWidget()
}

class ActivityWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = ActivityWidget()
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
                Row(GlanceModifier.fillMaxWidth().padding(end = 16.dp).clickable(open(LocalContext.current, task.id)), verticalAlignment = Alignment.CenterVertically) {
                    Tick(task, GlanceModifier.padding(start = 16.dp, end = 12.dp, top = 9.dp, bottom = 9.dp))
                    Words(task)
                }
            }
        }
    }
}

// The Timeline as the app draws it (TimelineScreen), in two widgets: Now and Today's Tasks, the free time and Upcoming
// meetings (Ahead); or what happened under each day, the tasks an entry brought hanging under it (Activity, with no +:
// nothing is added there); on one rail, scrolled
enum class Part { Ahead, Activity }

@Composable
internal fun RailTimeline(glimpse: Glimpse?, part: Part) = Frame(if (part == Part.Ahead) "Today" else "Activity", plus = part == Part.Ahead) {
    val ahead = part == Part.Ahead
    if (glimpse == null) return@Frame Note(if (ahead) "Open Orbital to see today's tasks and meetings here." else "Open Orbital to see what happened here.", GlanceModifier.clickable(openApp(LocalContext.current)))
    val context = LocalContext.current
    val now = Clock.System.now()
    val scale = context.resources.configuration.fontScale
    val line = (14 + 18 * scale).dp // one line a stop, at this phone's font size
    val time = (2 + 34 * scale).dp // the time column, as wide as "00:00"
    val today = if (ahead) glimpse.today else null
    val free = if (ahead) glimpse.free(now) else null
    val upcoming = if (ahead) glimpse.upcoming(now) else emptyList()
    val days = if (ahead) emptyList() else glimpse.activity(now)
    if (today == null && free == null && upcoming.isEmpty() && days.isEmpty()) {
        return@Frame Note(if (ahead) "Nothing pinned to today, and no meetings to come." else "Nothing yet. Changes to your tasks, new Inbox tasks and your meetings show up here.")
    }
    LazyColumn {
        var first = true
        fun LazyListScope.stop(label: String, opens: Action, marker: (@Composable () -> Unit)?, content: @Composable () -> Unit) {
            val top = first
            first = false
            item { RailRow(label, opens, line, time, top, marker, content) }
        }
        fun LazyListScope.meeting(m: Row, label: String, marker: (@Composable () -> Unit)?, content: @Composable () -> Unit) =
            stop(label, open(context, m.timeline?.uri ?: m.id), marker, content)
        fun LazyListScope.tasks(list: List<Row>) = list.forEach { t ->
            stop("", open(context, t.id), null) { Row(verticalAlignment = Alignment.CenterVertically) { Tick(t, GlanceModifier.padding(end = 10.dp).fillMaxHeight()); Words(t) } }
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
                    Row(verticalAlignment = Alignment.CenterVertically) { Glyph(if (m.icon == "pinRoute") "pinRoute" else "calendar", 14.dp, Glass.grey); Spacer(GlanceModifier.width(8.dp)); Words(m) }
                }
            }
        }
        if ((today != null || free != null || upcoming.isNotEmpty()) && days.isNotEmpty()) item { Divider() }
        days.forEach { (title, entries) ->
            item { Heading(title) }
            entries.forEach { (e, added) ->
                val marker: @Composable () -> Unit = { Marker(Glyphs.marker(e.icon), if (e.timeline?.recording == true) "live" else e.tone) }
                val label = e.timeline?.time ?: ""
                if (kindOf(e.timeline?.uri ?: "") == "event") { meeting(e, label, marker) { Words(e, quiet = e.tone == "faint") }; tasks(added) }
                else if (added.isNotEmpty()) {
                    // tasks added: the first on the time's line, its marker saying who added it, the rest under it
                    val first = added.first()
                    stop(label, open(context, first.id), marker) { Row(verticalAlignment = Alignment.CenterVertically) { Tick(first, GlanceModifier.padding(end = 10.dp).fillMaxHeight()); Words(first) } }
                    tasks(added.drop(1))
                }
                // a task's state changed: the task itself, the marker says what happened (asTask)
                else if (e.asTask() != null) {
                    val task = e.asTask()!!
                    stop(label, open(context, task.id), marker) { Row(verticalAlignment = Alignment.CenterVertically) { Tick(task, GlanceModifier.padding(end = 10.dp).fillMaxHeight()); Words(task) } }
                }
                // anything else: its title, the marker says what (Brief)
                else stop(label, e.timeline?.uri?.let { open(context, it) } ?: openApp(context), marker) { Brief(e, quiet = e.tone == "faint") }
            }
        }
    }
}

// the widget: its bar (the title opens the app, + opens Quick Add where there is one), then what it shows, in the app's colours
@Composable
private fun Frame(title: String, plus: Boolean = true, content: @Composable () -> Unit) {
    val context = LocalContext.current
    Column(GlanceModifier.fillMaxSize().appWidgetBackground().cornerRadius(android.R.dimen.system_app_widget_background_radius).background(Glass.back)) {
        Row(GlanceModifier.fillMaxWidth().height(48.dp).padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(title, GlanceModifier.defaultWeight().clickable(openApp(context)), style = TextStyle(Glass.ink, 17.sp, FontWeight.Bold), maxLines = 1)
            if (plus) Box(GlanceModifier.size(44.dp).clickable(openApp(context, "add")), contentAlignment = Alignment.Center) {
                Image(ImageProvider(R.drawable.add), "Quick Add Task", GlanceModifier.size(22.dp), colorFilter = ColorFilter.tint(Glass.ink))
            }
        }
        content()
    }
}

// One stop on the rail: the time, the marker on a line through the markers' middle, what happened. Nothing is laid
// behind a marker to hide the line, as the widget has no colour of its own to lay there: the line stops short of it
// (the iPhone's Rail), and the first stop's starts at its marker.
@Composable
private fun RailRow(label: String, opens: Action, height: Dp, time: Dp, first: Boolean, marker: (@Composable () -> Unit)?, content: @Composable () -> Unit) {
    Row(GlanceModifier.fillMaxWidth().height(height).padding(start = 12.dp, end = 4.dp).clickable(opens), verticalAlignment = Alignment.CenterVertically) {
        Text(label, GlanceModifier.width(time), style = TextStyle(Glass.grey, 12.sp, textAlign = TextAlign.End), maxLines = 1)
        Spacer(GlanceModifier.width(8.dp))
        Box(GlanceModifier.width(20.dp).fillMaxHeight(), contentAlignment = Alignment.Center) {
            Column(GlanceModifier.fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(GlanceModifier.width(1.dp).defaultWeight().background(if (first) Glass.none else Glass.rule)) {}
                if (marker != null) Spacer(GlanceModifier.height(22.dp))
                Box(GlanceModifier.width(1.dp).defaultWeight().background(Glass.rule)) {}
            }
            marker?.invoke()
        }
        Spacer(GlanceModifier.width(8.dp))
        Box(GlanceModifier.defaultWeight()) { content() }
        Spacer(GlanceModifier.width(10.dp))
    }
}

// The widgets have no background of their own, as the iPhone's on a clear Home Screen: the wallpaper shows through a
// light veil that keeps white words legible on a bright one (RemoteViews cannot blur it, as iOS's glass does), and
// everything is drawn in white at the iPhone's three strengths (primary, secondary, tertiary), in light and dark alike
private object Glass {
    val back = ColorProvider(Color.Black.copy(alpha = 0.3f))
    val ink = ColorProvider(Color.White)
    val grey = ColorProvider(Color.White.copy(alpha = 0.66f))
    val faint = ColorProvider(Color.White.copy(alpha = 0.42f))
    val rule = ColorProvider(Color.White.copy(alpha = 0.3f))
    val none = ColorProvider(Color.Transparent)
}

// the rail's marker (the iPhone's Marker on a clear Home Screen): finished work a check in a ring; a new task or a
// meeting with no write-up quieter; one being recorded in full white
@Composable
private fun Marker(glyph: String, tone: String?) {
    if (tone == "done") Box(GlanceModifier.size(18.dp), contentAlignment = Alignment.Center) {
        Image(ImageProvider(R.drawable.ring), null, GlanceModifier.size(18.dp), colorFilter = ColorFilter.tint(Glass.grey))
        Glyph("applyDone", 10.dp, Glass.ink)
    } else Glyph(glyph, 16.dp, if (tone == "live") Glass.ink else if (tone == "new" || tone == "faint") Glass.faint else Glass.grey)
}

// the app's box as the iPhone draws it on a clear Home Screen: an outline, a check in it once done, dashed for an Inbox task
@Composable
private fun TaskBox(state: String?) {
    Box(GlanceModifier.size(16.dp), contentAlignment = Alignment.Center) {
        if (state == "proposed") Image(ImageProvider(R.drawable.inbox_box), null, GlanceModifier.size(16.dp), colorFilter = ColorFilter.tint(Glass.faint))
        else Image(ImageProvider(R.drawable.box), null, GlanceModifier.size(16.dp), colorFilter = ColorFilter.tint(Glass.grey))
        if (state == "closed") Glyph("applyDone", 10.dp, Glass.ink)
    }
}

// a task's box on a widget: a tap opens the app, which writes it to Tana at once (orbital:check:<id>), by the app's own
// rule (Engine.toggle): an Inbox task is accepted and a done one ticked back on (open), any other ticked off; the row
// around it opens the task
@Composable
private fun Tick(task: Row, modifier: GlanceModifier) {
    val state = task.stateType
    val opens = state == "closed" || state == "proposed"
    val context = LocalContext.current
    val tick = openApp(context, (if (opens) "uncheck:" else "check:") + task.id)
    val said = (if (state == "closed") "Mark as not done" else if (state == "proposed") "Accept" else "Mark as done") +
        if (task.sensitive == true) "" else ", " + task.words // never a sensitive one's words
    Box(modifier.clickable(tick).semantics { contentDescription = said }, contentAlignment = Alignment.Center) { TaskBox(task.stateType) }
}

@Composable
private fun Glyph(name: String, size: Dp, tint: ColorProvider) =
    Image(ImageProvider(glyphBitmap(name, 72)), null, GlanceModifier.size(size), colorFilter = ColorFilter.tint(tint))

@Composable
private fun Words(words: String, quiet: Boolean = false, done: Boolean = false) =
    Text(words, style = TextStyle(if (quiet || done) Glass.grey else Glass.ink, 14.sp, textDecoration = if (done) TextDecoration.LineThrough else null), maxLines = 1)

// a row's words, a done task struck; a sensitive one a bar, as the app draws it until a shake (its words are never in a
// Glimpse the app kept)
@Composable
private fun Words(row: Row, quiet: Boolean = false) {
    if (row.sensitive != true) return Words(sentence(row).ifBlank { row.words }, quiet, done = row.stateType == "closed")
    Box(GlanceModifier.width((72 + (row.id.hashCode() and 63)).dp).height(9.dp).cornerRadius(3.dp).background(Glass.rule).semantics { contentDescription = "Sensitive" }) {}
}

// a row's segments as one line of words, a mention by its name
private fun sentence(row: Row) = row.segments.orEmpty().joinToString("") { it.text ?: it.mention?.label ?: "" }

// an Activity line: its sentence (main/timeline.js "Sam edited Onboarding flow") cut to the node's title, as the marker
// beside it says what happened. TalkBack still reads the whole sentence.
@Composable
private fun Brief(row: Row, quiet: Boolean) {
    val segments = row.segments.orEmpty() // Row is another module's: no smart cast on its fields
    val title = segments.lastOrNull { it.content == true }?.text
    if (row.sensitive == true || title == null) return Words(row, quiet)
    val said = sentence(row)
    Box(GlanceModifier.semantics { contentDescription = said }) { Words(title, quiet) }
}

// a day's heading, smaller than a line so more of what happened fits
@Composable
private fun Heading(title: String) =
    Text(title, GlanceModifier.fillMaxWidth().padding(start = 20.dp, top = 6.dp, bottom = 2.dp), style = TextStyle(Glass.grey, 12.sp, FontWeight.Bold), maxLines = 1)

@Composable
private fun Divider() =
    Box(GlanceModifier.fillMaxWidth().height(17.dp).padding(start = 20.dp, end = 16.dp, top = 8.dp, bottom = 8.dp)) { Box(GlanceModifier.fillMaxSize().background(Glass.rule)) {} }

@Composable
private fun Note(words: String, modifier: GlanceModifier = GlanceModifier) =
    Text(words, modifier.padding(horizontal = 16.dp, vertical = 4.dp), style = TextStyle(Glass.grey, 14.sp))

// the iPhone widgets' orbital: links (MainActivity link, ui/Shell.kt Link): a node opened in the app, Quick Add, a task
// ticked, or the Timeline; each intent unique by its link, through Orbital's own way in, so a box ticks at once
private fun open(context: Context, id: String) = openApp(context, id)
private fun openApp(context: Context, what: String = "timeline"): Action =
    actionStartActivity(Intent(context, FromOrbital::class.java).setData(Uri.fromParts("orbital", what, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
