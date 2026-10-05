package com.dreetje.orbital

import java.io.File
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.minutes
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

    // The widgets' Timeline (androidApp Widgets.kt, ios/Widgets): the rows as the app shows them, a box ticked here
    // ticked, the words of anything sensitive left out (nobody shakes a widget)
    @Test fun theWidgetsGlimpseLeavesOutSensitiveWords() = runTest {
        val engine = Engine(null, FakePlatform(), backgroundScope, sample = sampleFile("timeline-sample.json") to sampleFile("pages-sample.json"), demoMode = false)
        engine.toggle(engine.rows.first { it.timeline?.today == true }.children!!.first())
        val glimpse = engine.glimpse()
        val today = glimpse.today!!
        assertEquals(listOf("closed", "open", "closed"), today.map { it.stateType })
        assertEquals(true, today[1].sensitive)
        assertFalse("offsite agenda" in json.encodeToString(glimpse))
    }

    // The sample on the Activity's immediate Main dispatcher: init keeps the Timeline at once, the launcher's tasks with
    // it, before anything declared later in Engine (found on a device: every sample launch crashed in keepTasks)
    @Test fun theSampleStartsOnAnImmediateDispatcher() {
        val platform = FakePlatform()
        Engine(null, platform, kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined), sample = sampleFile("timeline-sample.json") to sampleFile("pages-sample.json"), demoMode = false)
        assertTrue(platform.tasks.single()!!.any { it.words == "Draft the Q4 hiring plan" })
    }

    // drawn later than it was read: a meeting that has started is no longer to come, and free time that ended is gone
    // The sample has no engine and so no prompts (the iPhone's -sample the same): nothing is translated, and a model goes by its id
    @Test fun theSampleTranslatesNothingAndNamesModelsByTheirIds() = runTest {
        val engine = Engine(null, FakePlatform(chatgpt = FakeChatGPT(signedIn = true)), backgroundScope, sample = sampleFile("timeline-sample.json") to sampleFile("pages-sample.json"), demoMode = false)
        engine.translate("Dutch")
        assertNull(engine.translator.prompts)
        assertEquals("gpt-6-sol", engine.translator.label("gpt-6-sol"))
        assertEquals("Draft the Q4 hiring plan" to null, engine.translator.words("Draft the Q4 hiring plan"))
    }

    @Test fun aGlimpseDrawnLaterDropsWhatHasStartedOrEnded() {
        val now = Instant.parse("2026-10-02T12:00:00Z")
        val glimpse = Glimpse(now.toEpochMilliseconds(), Engine.sampleRows(sampleFile("timeline-sample.json"), now))
        assertEquals(3, glimpse.upcoming(now).size)
        assertNull(glimpse.free(now + 50.minutes))
        assertEquals(listOf("1:1 Sam / Andre"), glimpse.upcoming(now + 50.minutes).map { it.words })
    }
}

// the repository, as shared/build.gradle.kts hands it to the tests (orbital.repo), whatever directory they run in
fun sampleFile(name: String) = File(System.getProperty("orbital.repo") ?: "../..", "ios/Orbital/$name").readText()
