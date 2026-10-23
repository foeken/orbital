package com.dreetje.orbital

import kotlinx.datetime.TimeZone
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Instant

// How the screens lay rows out, apart from drawing them: the Timeline's days, a search's sections, an outline
// flattened, and the free time's words (ios/Orbital Timeline.swift, Pages.swift)
object Lists {
    // Today, Yesterday and each day before, by the day the engine put each row under (renderer/timeline.js
    // timelineGroups, ios/engine/labels.js); the blocks above the days (today's tasks, the free time, the meetings to
    // come) are drawn apart
    fun days(rows: List<Row>, now: Instant, zone: TimeZone = TimeZone.currentSystemDefault()): List<Pair<String, List<Row>>> {
        val out = mutableListOf<Triple<String, String, MutableList<Row>>>() // the day, its heading, its rows
        for (row in rows) {
            if (row.top) continue
            val t = row.timeline
            val key = t?.day ?: ""
            if (out.lastOrNull()?.first == key) out.last().third.add(row) else out.add(Triple(key, Times.day(key, t?.dayTitle, now, zone), mutableListOf(row)))
        }
        return out.map { it.second to it.third }
    }

    // consecutive rows under one heading; one untitled section when the search is not grouped
    fun sections(rows: List<Row>): List<Pair<String?, List<Row>>> {
        val out = mutableListOf<Pair<String?, MutableList<Row>>>()
        for (row in rows) if (out.isNotEmpty() && out.last().first == row.group) out.last().second.add(row) else out.add(row.group to mutableListOf(row))
        return out
    }

    // the outline flattened, each row with how deep it sits: nothing folds on the phone, everything shows
    fun flat(rows: List<Row>, depth: Int = 0): List<Pair<Row, Int>> =
        rows.filter { !it.blank }.flatMap { listOf(it to depth) + flat(it.children ?: emptyList(), depth + 1) }

    // a day as Tana mentions one (sdk/dates.js): tana:plaindate:YYYY-MM-DD
    fun plainDate(year: Int, month: Int, day: Int) = "tana:plaindate:" + year.toString().padStart(4, '0') + "-" + month.toString().padStart(2, '0') + "-" + day.toString().padStart(2, '0')

    fun parsePlainDate(uri: String): Triple<Int, Int, Int>? {
        val parts = uri.removePrefix("tana:plaindate:").split("-").mapNotNull { it.toIntOrNull() }
        return if (uri.startsWith("tana:plaindate:") && parts.size == 3) Triple(parts[0], parts[1], parts[2]) else null
    }
}
