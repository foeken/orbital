package com.dreetje.orbital

import kotlinx.serialization.Serializable
import kotlin.time.Instant

// The Timeline at a glance, for the widgets (androidApp Widgets.kt, ios/Widgets): the rows as the app last showed them
// and each meeting's documents, kept on the phone after every read (Engine.glimpse), as a widget cannot run the
// engine. The words of anything sensitive are not in it: nobody shakes a widget, and a cover screen is read shut.
// The iPhone writes the same JSON (Engine.swift glimpse), so one shape for both phones.
@Serializable
data class Glimpse(val read: Long, val rows: List<Row>, val docs: Map<String, List<Row>> = emptyMap()) {
    // Today's Tasks, when the Timeline has the block
    val today: List<Row>? get() = rows.firstOrNull { it.timeline?.today == true }?.let { it.children ?: emptyList() }

    // drawn later than it was read: free time that has ended is gone, and a meeting that has started is no longer to come
    fun free(now: Instant): Row.Free? = rows.firstNotNullOfOrNull { it.timeline?.free }?.takeIf { it.until > now.toEpochMilliseconds() }
    fun upcoming(now: Instant): List<Row> = rows.firstOrNull { it.timeline?.upcoming == true }?.children.orEmpty().filter { (it.start?.let(::parseTime) ?: now) > now }
}
