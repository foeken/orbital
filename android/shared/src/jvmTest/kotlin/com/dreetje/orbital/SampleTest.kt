package com.dreetje.orbital

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Instant

// The iPhone's invented content (ios/Orbital/*-sample.json) read as the Android app reads it: one sample for both phones
class SampleTest {
    @Test fun theTimelineSampleReadsWithItsTimesFilledIn() {
        val now = Instant.parse("2026-10-02T12:00:00Z")
        val rows = Engine.sampleRows(sampleFile("timeline-sample.json"), now)
        assertTrue(rows.isNotEmpty())
        val today = rows.first { it.timeline?.today == true }
        assertEquals(listOf("open", "open", "closed"), today.children!!.map { it.stateType })
        val free = rows.first { it.timeline?.free != null }.timeline!!.free!!
        assertEquals(44 * 60_000.0, free.until - free.from)
        assertTrue(rows.all { row -> row.createdAt.let { it == null || parseTime(it) != null } })
    }

    @Test fun thePagesSampleHasTheFirstSavedSearchsPage() {
        val sample = json.decodeFromString<Sample>(sampleFile("pages-sample.json"))
        assertTrue(sample.searches.isNotEmpty())
        assertTrue(sample.searches.any { it.glyph != null }) // an icon given with Set icon, as a PNG
        assertTrue(sample.searches.first().id in sample.pages) // the one the menu test opens; the rest say "Not in the sample", as on the iPhone
    }
}

// the repository, as shared/build.gradle.kts hands it to the tests (orbital.repo), whatever directory they run in
fun sampleFile(name: String) = File(System.getProperty("orbital.repo") ?: "../..", "ios/Orbital/$name").readText()
