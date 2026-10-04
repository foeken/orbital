package com.dreetje.orbital

import kotlinx.serialization.Serializable
import kotlin.time.Instant

// The Timeline at a glance, for the widgets (androidApp Widgets.kt, ios/Widgets): the rows as the app last showed them
// and each meeting's documents, kept on the phone after every read (Engine.glimpse), as a widget cannot run the
// engine. The words of anything sensitive are not in it: nobody shakes a widget, and a cover screen is read shut.
// The iPhone writes the same JSON (Engine.swift glimpse), so one shape for both phones.
@Serializable
data class Glimpse(val read: Long, val rows: List<Row>) {
    // Today's Tasks, when the Timeline has the block
    val today: List<Row>? get() = rows.firstOrNull { it.timeline?.today == true }?.let { it.children ?: emptyList() }

    // drawn later than it was read: free time that has ended is gone, and a meeting that has started is no longer to come
    fun free(now: Instant): Row.Free? = rows.firstNotNullOfOrNull { it.timeline?.free }?.takeIf { it.until > now.toEpochMilliseconds() }
    fun upcoming(now: Instant): List<Row> = rows.firstOrNull { it.timeline?.upcoming == true }?.children.orEmpty().filter { (it.start?.let(::parseTime) ?: now) > now }

    // What happened, under each day (Lists.days), for the Activity widget, each task once: at the latest thing that
    // happened to it (the rows come newest first), so a task added and then completed is the completion alone. A line of
    // tasks added keeps the ones nothing happened to since, and goes when none is left; a day left empty goes too; a
    // meeting is always itself. With each line, the tasks it brought. The iPhone's ios/Widgets Glimpse.activity mirrors it.
    fun activity(now: Instant): List<Pair<String, List<Pair<Row, List<Row>>>>> {
        val seen = mutableSetOf<String>()
        return Lists.days(rows, now).map { (title, entries) ->
            title to entries.mapNotNull { e ->
                val added = e.children.orEmpty()
                when {
                    kindOf(e.timeline?.uri ?: "") == "event" -> e to added
                    added.isEmpty() -> (e to added).takeIf { e.timeline?.uri?.let(seen::add) != false }
                    else -> added.filter { seen.add(it.id) }.takeIf { it.isNotEmpty() }?.let { e to it }
                }
            }
        }.filter { it.second.isNotEmpty() }
    }
}

// An Activity line about a task's state ("completed Plan the offsite"), drawn as the task itself: its box in the state
// the line left it in (the line's icon, main/timeline.js ICON) or a tick made since (Engine.glimpse keeps it on the line),
// and its title. Null for any other line: an edit, a meeting.
// The iPhone's ios/Widgets Row.asTask is the same.
private val stateOfIcon = mapOf("apply" to "closed", "tlAccepted" to "open", "tlLater" to "not_now", "tlInbox" to "proposed")
fun Row.asTask(): Row? {
    val uri = timeline?.uri ?: return null
    val state = stateOfIcon[icon] ?: return null
    if (kindOf(uri) != "text") return null
    return Row(uri, title = segments?.lastOrNull { it.content == true }?.text ?: words, stateType = stateType ?: state, sensitive = sensitive)
}
