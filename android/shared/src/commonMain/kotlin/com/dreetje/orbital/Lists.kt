package com.dreetje.orbital

import kotlin.math.ceil
import kotlin.math.max
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Instant

// How the screens lay rows out, apart from drawing them: the Timeline's days, a search's sections, an outline
// flattened, a chat's names and its waiting dots, and the free time's words (ios/Orbital Timeline.swift, Pages.swift)
object Lists {
    // Today, Yesterday and each day before, by the rows' own time (renderer/timeline.js timelineGroups); the blocks
    // above the days (today's tasks, the free time, the meetings to come) are drawn apart
    fun days(rows: List<Row>, now: Instant): List<Pair<String, List<Row>>> {
        val out = mutableListOf<Pair<String, MutableList<Row>>>()
        for (row in rows) {
            val t = row.timeline
            if (t?.today == true || t?.upcoming == true || t?.free != null) continue
            val title = Times.day(row.instant, now)
            if (out.lastOrNull()?.first == title) out.last().second.add(row) else out.add(title to mutableListOf(row))
        }
        return out
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

    // the name over a run of replies, not over each (renderer/chat.js chatNameEl): a status line breaks the run
    fun named(row: Row, prev: Row?): Boolean =
        row.chat?.mine != true && row.chat?.status != true && (prev == null || prev.chat?.status == true || prev.chat?.author != row.chat?.author)

    // Tana writing (its message streaming with no words yet), or your message still unanswered for two minutes at
    // most (renderer/chat.js CHAT_WAIT)
    fun waiting(rows: List<Row>, since: Instant?, now: Instant): Boolean {
        val last = rows.lastOrNull { it.chat?.status != true }
        if (last?.chat?.streaming == true) return last.children.isNullOrEmpty()
        return last?.chat?.mine == true && since != null && now - since < 2.minutes
    }

    // The free time before the next meeting, counted down while it shows (renderer/timeline.js timelineFreeSegs):
    // "No meetings for ", the time in bold, and " after this one" while a meeting is still on
    fun free(f: Row.Free, nowMs: Double): Triple<String, String, String> {
        val later = f.from > nowMs
        val m = max(1, ceil((f.until - max(nowMs, f.from)) / 60000).toInt())
        val left = if (m < 60) "$m " + (if (later) "" else "more ") + "min" else "${m / 60} h" + (if (m % 60 > 0) " ${m % 60} min" else "")
        return Triple("No meetings for ", left, if (later) " after this one" else "")
    }

    // a day as Tana mentions one (sdk/dates.js): tana:plaindate:YYYY-MM-DD
    fun plainDate(year: Int, month: Int, day: Int) = "tana:plaindate:" + year.toString().padStart(4, '0') + "-" + month.toString().padStart(2, '0') + "-" + day.toString().padStart(2, '0')

    fun parsePlainDate(uri: String): Triple<Int, Int, Int>? {
        val parts = uri.removePrefix("tana:plaindate:").split("-").mapNotNull { it.toIntOrNull() }
        return if (uri.startsWith("tana:plaindate:") && parts.size == 3) Triple(parts[0], parts[1], parts[2]) else null
    }
}
