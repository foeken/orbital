package com.dreetje.orbital.android

import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.datastore.preferences.core.emptyPreferences
import androidx.glance.appwidget.testing.unit.runGlanceAppWidgetUnitTest
import androidx.glance.testing.unit.hasContentDescription
import androidx.glance.testing.unit.hasText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.dreetje.orbital.Engine
import com.dreetje.orbital.Glimpse
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.time.Clock
import kotlin.time.Duration.Companion.seconds

// The widgets (Widgets.kt) as Glance lays them out, on the iPhone's invented sample: the home screen's Today's Tasks
// across its whole width, and the cover screen's Timeline on its rail, in two
@RunWith(AndroidJUnit4::class)
class WidgetsTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun asset(name: String) = context.assets.open(name).bufferedReader().use { it.readText() }
    private val glimpse by lazy { Glimpse(System.currentTimeMillis(), Engine.sampleRows(asset("timeline-sample.json"), Clock.System.now())) }
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

    @Test fun theTodayCoverWidgetIsTheTimelineAboveItsLine() = runGlanceAppWidgetUnitTest(timeout = 20.seconds) {
        setContext(context)
        setAppWidgetSize(cover)
        setState(emptyPreferences())
        provideComposable { RailTimeline(glimpse, Part.Ahead) }
        onNode(hasText("Now")).assertExists()
        onNode(hasText("Today's Tasks")).assertExists()
        onNode(hasText("Upcoming meetings")).assertExists()
        onNode(hasText("Design review")).assertExists()
        onNode(hasContentDescription("Quick Add Task")).assertExists()
        onNode(hasText("Rotate the staging API keys")).assertDoesNotExist() // what happened is the Activity widget's
        onNode(hasText("Send the offsite agenda")).assertDoesNotExist()
        onAllNodes(hasContentDescription("Show documents")).assertCountEquals(0) // nothing opens in place: a meeting opens in the app
    }

    @Test fun theActivityCoverWidgetIsWhatHappenedWithNoPlus() = runGlanceAppWidgetUnitTest(timeout = 20.seconds) {
        setContext(context)
        setAppWidgetSize(cover)
        setState(emptyPreferences())
        provideComposable { RailTimeline(glimpse, Part.Activity) }
        onNode(hasText("Activity")).assertExists()
        onNode(hasText("Rotate the staging API keys")).assertExists() // a task an entry brought, hanging under it
        onNode(hasText("Retro, sprint 42")).assertExists() // further down: the widget scrolls
        // a line about a task is the task, its box ticked as the line left it; the marker says what happened, no sentence
        onNode(hasText("Write the launch checklist")).assertExists()
        onNode(hasContentDescription("Mark as not done, Write the launch checklist")).assertExists()
        onNode(hasText("Priya")).assertDoesNotExist()
        onNode(hasText("completed")).assertDoesNotExist()
        // tasks added: the first on the time's line, no "An AI agent added 2 tasks to your Inbox" line above them
        onNode(hasText("Upgrade the build agents before 24 November")).assertExists()
        // an Inbox task's box accepts it, as the app's box does (Engine.toggle), rather than ticking it off
        onNode(hasContentDescription("Accept, Rotate the staging API keys")).assertExists()
        onNode(hasText("added 2 tasks")).assertDoesNotExist()
        onNode(hasText("Upcoming meetings")).assertDoesNotExist()
        onNode(hasText("Today's Tasks")).assertDoesNotExist()
        onNode(hasContentDescription("Quick Add Task")).assertDoesNotExist() // nothing is added there
    }
}
