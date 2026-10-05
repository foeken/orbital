package com.dreetje.orbital

import kotlin.math.ceil
import kotlin.math.max

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
}
