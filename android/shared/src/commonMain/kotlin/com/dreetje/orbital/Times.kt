package com.dreetje.orbital

import kotlinx.datetime.DayOfWeek
import kotlinx.datetime.DateTimeUnit
import kotlinx.datetime.LocalDate
import kotlinx.datetime.Month
import kotlinx.datetime.TimeZone
import kotlinx.datetime.minus
import kotlinx.datetime.toLocalDateTime
import kotlin.math.abs
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Instant

// The words the screens put on a time, in this phone's time zone: a day's heading, a day picked in Quick Add, and how
// long ago a row in a list last changed. A Timeline row's own time and day come worded from the engine
// (ios/engine/labels.js, Row.Info), as the desktop words them; only the invented sample, which never passes through
// it, is worded here (sample).
object Times {
    // the rail's clock as the desktop's (renderer/timeline.js timelineTime): 24-hour and two digits, so a column lines up
    fun hm(at: Instant, zone: TimeZone = TimeZone.currentSystemDefault()): String {
        val t = at.toLocalDateTime(zone)
        return t.hour.toString().padStart(2, '0') + ":" + t.minute.toString().padStart(2, '0')
    }

    // the sign-in log's clock: 23:14:05
    fun hms(at: Instant, zone: TimeZone = TimeZone.currentSystemDefault()): String {
        val t = at.toLocalDateTime(zone)
        return listOf(t.hour, t.minute, t.second).joinToString(":") { it.toString().padStart(2, '0') }
    }

    // A day's heading (renderer/timeline.js timelineDay; Timeline.swift day): Today and Yesterday said here against this
    // phone's date, so they are right past midnight before the next read; any other day in the engine's words for it
    fun day(key: String, title: String?, now: Instant, zone: TimeZone = TimeZone.currentSystemDefault()): String {
        val today = now.toLocalDateTime(zone).date
        return when (key) {
            today.toString() -> "Today"
            today.minus(1, DateTimeUnit.DAY).toString() -> "Yesterday"
            else -> title ?: key
        }
    }

    fun long(d: LocalDate): String = weekday(d.dayOfWeek) + " " + d.day + " " + month(d.month)

    // -sample (Engine.sampleRows): what the engine puts on a Timeline row (ios/engine/labels.js), for invented rows that
    // never pass through it, minutes from now as their createdAt is: "{{hm:-40}}" the time, "{{day:-40}}" the day,
    // "{{date:-40}}" that day in words (Engine.swift showSample)
    fun sample(text: String, now: Instant, zone: TimeZone = TimeZone.currentSystemDefault()): String =
        Regex("\"\\{\\{(hm|day|date):([+-]?\\d+)\\}\\}\"").replace(text) { m ->
            val at = now + m.groupValues[2].toLong().minutes
            val d = at.toLocalDateTime(zone).date
            "\"" + when (m.groupValues[1]) { "hm" -> hm(at, zone); "day" -> d.toString(); else -> long(d) } + "\""
        }

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
