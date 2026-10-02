package com.dreetje.orbital

import kotlinx.datetime.DayOfWeek
import kotlinx.datetime.LocalDate
import kotlinx.datetime.Month
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlin.math.abs
import kotlin.time.Instant

// The words the screens put on a time, in this phone's time zone: a row's time on the rail, a day's heading, and how
// long ago a row in a list last changed. 24-hour, as the engine's own subtexts are ("14:15–14:45", sdk/chat.js hm).
object Times {
    fun hm(at: Instant, zone: TimeZone = TimeZone.currentSystemDefault()): String {
        val t = at.toLocalDateTime(zone)
        return t.hour.toString() + ":" + t.minute.toString().padStart(2, '0')
    }

    // the sign-in log's clock: 23:14:05
    fun hms(at: Instant, zone: TimeZone = TimeZone.currentSystemDefault()): String {
        val t = at.toLocalDateTime(zone)
        return listOf(t.hour, t.minute, t.second).joinToString(":") { it.toString().padStart(2, '0') }
    }

    // Today, Yesterday and each day before, by the rows' own time (renderer/timeline.js timelineGroups)
    fun day(at: Instant, now: Instant, zone: TimeZone = TimeZone.currentSystemDefault()): String {
        val d = at.toLocalDateTime(zone).date
        val today = now.toLocalDateTime(zone).date
        return when (today.toEpochDays() - d.toEpochDays()) {
            0L -> "Today"
            1L -> "Yesterday"
            else -> long(d)
        }
    }

    fun long(d: LocalDate): String = weekday(d.dayOfWeek) + " " + d.day + " " + month(d.month)

    private fun weekday(d: DayOfWeek) = d.name.lowercase().replaceFirstChar { it.uppercase() }
    private fun month(m: Month) = m.name.lowercase().replaceFirstChar { it.uppercase() }

    // "5 minutes ago", "yesterday", "last week": iOS's relative named presentation, in English as the app's words are
    fun relative(at: Instant, now: Instant, zone: TimeZone = TimeZone.currentSystemDefault()): String {
        val seconds = (now - at).inWholeSeconds
        val ago = seconds >= 0
        val s = abs(seconds)
        fun say(n: Long, unit: String) = if (ago) "$n $unit" + (if (n == 1L) "" else "s") + " ago" else "in $n $unit" + (if (n == 1L) "" else "s")
        if (s < 60) return "now"
        if (s < 3600) return say(s / 60, "minute")
        val days = abs(now.toLocalDateTime(zone).date.toEpochDays() - at.toLocalDateTime(zone).date.toEpochDays())
        if (s < 86400 && days == 0L) return say(s / 3600, "hour")
        if (days <= 1L) return if (ago) "yesterday" else "tomorrow"
        if (days < 7) return say(days, "day")
        if (days < 30) return (days / 7).let { if (it == 1L) (if (ago) "last week" else "next week") else say(it, "week") }
        if (days < 365) return (days / 30).let { if (it == 1L) (if (ago) "last month" else "next month") else say(it, "month") }
        return (days / 365).let { if (it == 1L) (if (ago) "last year" else "next year") else say(it, "year") }
    }
}
