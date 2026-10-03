package com.dreetje.orbital

import kotlinx.datetime.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Instant

// The invented sample worded as the engine words a real Timeline (ios/engine/labels.js; Times.sample, Engine.swift
// showSample): every entry has its time on the rail, its day and that day in words, and the days head as on the iPhone
class SampleWordsTest {
    @Test fun everyEntryOfTheSampleHasItsTimeAndItsDay() {
        val now = Instant.parse("2026-10-02T12:00:00Z")
        val rows = Engine.sampleRows(Times.sample(sampleFile("timeline-sample.json"), now, TimeZone.UTC), now)
        val entries = rows.filter { it.timeline?.today != true && it.timeline?.upcoming != true && it.timeline?.free == null }
        assertTrue(entries.isNotEmpty())
        for (e in entries) { val t = e.timeline; assertTrue(t != null && Regex("\\d\\d:\\d\\d").matches(t.time ?: "") && t.day != null && t.dayTitle != null, e.id) }
        assertEquals(listOf("Today", "Yesterday"), Lists.days(rows, now, TimeZone.UTC).map { it.first })
    }
}
