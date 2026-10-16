package com.dreetje.orbital

import kotlin.math.ceil
import kotlin.math.max
import kotlinx.datetime.LocalDate

// The app's own words for what Tana says, in one place: a task's state, who can see a document, how far your agent is,
// the free time before the next meeting. The iPhone's ios/Common/Phrases.swift is the same, names and all, and both
// phones hold theirs to ios/PhoneSpec.json (SpecTest here, SpecTests.swift there).
object Phrases {
    // Tana's four states, as the desktop's Status pill names them (renderer/pills.js)
    val states = listOf("proposed" to "Inbox", "open" to "In Progress", "closed" to "Completed", "not_now" to "Later")
    fun state(state: String?): String = states.firstOrNull { it.first == state }?.second ?: "In Progress"

    // renderer/tasks.js AUDIENCES: who can see a document, its word and its glyph, a space by its name
    fun audience(scope: String, space: String?): Pair<String, String> = when (scope) {
        "only-me" -> "Only you" to "lock"
        "people" -> "Selected people" to "userLock"
        "space" -> (space?.let { "Members of $it" } ?: "Space members") to "houseLock"
        "everyone" -> "Everyone" to "users"
        else -> "Unknown" to "hidden"
    }

    // a node's last Agent status line, as the Mac's badge reads it: Assigned is waiting for the agent to pick it up
    fun agent(status: String): String = mapOf("assigned" to "Assigned", "working" to "Working", "completed" to "Completed", "failed" to "Failed")[status] ?: "Assigned"

    // The free time before the next meeting, counted down while it shows (renderer/timeline.js timelineFreeSegs):
    // "No meetings for ", the time in bold, and " after this one" while a meeting is still on
    fun free(from: Double, until: Double, now: Double): Triple<String, String, String> {
        val later = from > now
        val m = max(1, ceil((until - max(now, from)) / 60000).toInt())
        val left = if (m < 60) "$m " + (if (later) "" else "more ") + "min" else "${m / 60} h" + (if (m % 60 > 0) " ${m % 60} min" else "")
        return Triple("No meetings for ", left, if (later) " after this one" else "")
    }

    // A node's pinned days (YYYY-MM-DD, orbital.setup days): its pin menu lists today, tomorrow and every later day it is
    // pinned to, each with whether it is; the line under its title names those from today on. Days gone by stay pinned
    // until Remove All Pins and are not listed: a task pinned day after day would fill the menu.
    fun pinChoices(days: List<String>, today: String, tomorrow: String): List<Pair<String, Boolean>> =
        (listOf(today, tomorrow) + days.filter { it > tomorrow }.distinct().sorted()).map { it to (it in days) }
    fun pinnedTo(days: List<String>, today: String, tomorrow: String): String? {
        val words = days.filter { it >= today }.distinct().sorted().map { if (it == today) "today" else if (it == tomorrow) "tomorrow" else day(it) }
        if (words.isEmpty()) return null
        return "Pinned to " + if (words.size == 1) words[0] else words.dropLast(1).joinToString(", ") + " and " + words.last()
    }
    fun pinDay(key: String, today: String, tomorrow: String): String = if (key == today) "Today" else if (key == tomorrow) "Tomorrow" else day(key)
    // YYYY-MM-DD as "Fri 23 Oct", in the app's English whatever the phone's language
    fun day(key: String): String {
        val p = key.split("-").mapNotNull { it.toIntOrNull() }
        val d = if (p.size == 3) runCatching { LocalDate(p[0], p[1], p[2]) }.getOrNull() else null
        if (d == null) return key
        fun short(name: String) = name.take(3).lowercase().replaceFirstChar { it.uppercase() }
        return short(d.dayOfWeek.name) + " " + p[2] + " " + short(d.month.name)
    }
}
