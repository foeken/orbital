package com.dreetje.orbital.android

import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.preferencesOf
import androidx.glance.action.actionParametersOf
import androidx.glance.appwidget.testing.unit.hasRunCallbackClickAction
import androidx.glance.appwidget.testing.unit.runGlanceAppWidgetUnitTest
import androidx.glance.testing.unit.hasContentDescription
import androidx.glance.testing.unit.hasText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.dreetje.orbital.Engine
import com.dreetje.orbital.Glimpse
import com.dreetje.orbital.Sample
import com.dreetje.orbital.json
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.time.Clock
import kotlin.time.Duration.Companion.seconds

// The widgets (Widgets.kt) as Glance lays them out, on the iPhone's invented sample: the home screen's Today's Tasks
// across its whole width, and the cover screen's Timeline on its rail, a meeting opening its documents in place
@RunWith(AndroidJUnit4::class)
class WidgetsTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun asset(name: String) = context.assets.open(name).bufferedReader().use { it.readText() }
    private val design = "tana:event:0000000000000000000000000d" // Design review, with Offsite planning on it
    private val glimpse by lazy {
        val pages = json.decodeFromString<Sample>(asset("pages-sample.json")).pages
        Glimpse(System.currentTimeMillis(), Engine.sampleRows(asset("timeline-sample.json"), Clock.System.now()), mapOf(design to pages.getValue(design).rows))
    }
    private val cover = DpSize(352.dp, 339.dp) // the Flip's Flex Window, as Samsung sizes its widgets

    @Test fun theHomeWidgetIsTodaysTasksAcrossItsWidth() = runGlanceAppWidgetUnitTest(timeout = 20.seconds) {
        setContext(context)
        setAppWidgetSize(DpSize(250.dp, 180.dp))
        provideComposable { TodayTasks(glimpse) }
        onNode(hasText("Today's Tasks")).assertExists()
        onNode(hasText("Draft the Q4 hiring plan")).assertExists()
        onNode(hasText("Review the design crit notes")).assertExists()
        onNode(hasContentDescription("Sensitive")).assertExists()
        onNode(hasText("Send the offsite agenda")).assertDoesNotExist()
        onNode(hasText("Now")).assertDoesNotExist() // no rail, no time column
        onNode(hasText("Upcoming meetings")).assertDoesNotExist()
    }

    @Test fun beforeTheAppHasReadAnythingTheHomeWidgetSaysWhereToStart() = runGlanceAppWidgetUnitTest(timeout = 20.seconds) {
        setContext(context)
        setAppWidgetSize(DpSize(250.dp, 130.dp))
        provideComposable { TodayTasks(null) }
        onNode(hasText("Open Orbital to see today's tasks here.")).assertExists()
    }

    @Test fun theCoverWidgetIsTheWholeTimelineOnItsRail() = runGlanceAppWidgetUnitTest(timeout = 20.seconds) {
        setContext(context)
        setAppWidgetSize(cover)
        setState(emptyPreferences()) // no meeting opened
        provideComposable { RailTimeline(glimpse) }
        onNode(hasText("Now")).assertExists()
        onNode(hasText("Today's Tasks")).assertExists()
        onNode(hasText("Upcoming meetings")).assertExists()
        onNode(hasText("Design review")).assertExists()
        onNode(hasText("Rotate the staging API keys")).assertExists() // a task an entry brought, hanging under it
        onNode(hasText("Retro, sprint 42")).assertExists() // further down: the widget scrolls
        onNode(hasText("Send the offsite agenda")).assertDoesNotExist()
        onNode(hasText("Offsite planning")).assertDoesNotExist() // a meeting's documents show when it is opened
        onAllNodes(hasContentDescription("Show documents")).assertCountEquals(1) // only a meeting that has some
        onNode(hasContentDescription("Show documents")).assert(hasRunCallbackClickAction<ShowDocuments>(actionParametersOf(ShowDocuments.MEETING to design)))
    }

    @Test fun anOpenedMeetingShowsItsDocumentsInPlace() = runGlanceAppWidgetUnitTest(timeout = 20.seconds) {
        setContext(context)
        setAppWidgetSize(cover)
        setState(preferencesOf(ShowDocuments.OPEN to setOf(design)))
        provideComposable { RailTimeline(glimpse) }
        onNode(hasText("Offsite planning")).assertExists()
        onNode(hasContentDescription("Hide documents")).assertExists()
    }
}
