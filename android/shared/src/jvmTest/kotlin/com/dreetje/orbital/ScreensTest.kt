package com.dreetje.orbital

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasStateDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import androidx.compose.ui.test.DesktopComposeUiTest
import com.dreetje.orbital.ui.OrbitalApp
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// The app on its invented content, driven as a finger is (the iPhone's OrbitalUITests/SampleTests, case for case):
// every element is found by what TalkBack reads, so a test that cannot find something is also a screen TalkBack cannot read
@OptIn(ExperimentalTestApi::class)
class ScreensTest {
    private fun sample(width: Int = 412, height: Int = 915, test: DesktopComposeUiTest.(Engine) -> Unit) = runDesktopComposeUiTest(width, height) {
        val scope = MainScope() // the Activity's viewModelScope here: ended with the test, so no work outlives it into the next
        try {
            val engine = Engine(null, FakePlatform(), scope, sample = sampleFile("timeline-sample.json") to sampleFile("pages-sample.json"), demoMode = false)
            setContent { OrbitalApp(engine) }
            waitUntil(timeoutMillis = 5000) { onAllWithText("Today's Tasks").isNotEmpty() }
            test(engine)
        } finally {
            scope.cancel()
        }
    }

    private fun DesktopComposeUiTest.onAllWithText(t: String) = onAllNodes(hasText(t, substring = true), useUnmergedTree = true).fetchSemanticsNodes()
    private fun DesktopComposeUiTest.box(words: String): SemanticsNodeInteraction = onNode(hasContentDescription(words) and (hasStateDescription("Completed") or hasStateDescription("Not completed") or hasStateDescription("In your Inbox")))

    @Test fun theTimelineShowsTodaysTasks() = sample {
        box("Draft the Q4 hiring plan").assert(hasStateDescription("Not completed"))
        box("Review the design crit notes").assert(hasStateDescription("Completed"))
    }

    @Test fun tickingATaskOffAndBackOn() = sample {
        val draft = box("Draft the Q4 hiring plan")
        draft.performClick()
        waitUntil(timeoutMillis = 3000) { runCatching { draft.assert(hasStateDescription("Completed")) }.isSuccess }
        draft.performClick()
        waitUntil(timeoutMillis = 3000) { runCatching { draft.assert(hasStateDescription("Not completed")) }.isSuccess }
    }

    @Test fun aSensitiveTaskShowsNoWords() = sample { engine ->
        box("Sensitive task").assertExists()
        onAllNodes(hasContentDescription("Sensitive, shake to show")).fetchSemanticsNodes().let { assertTrue(it.isNotEmpty()) }
        assertFalse(onAllNodes(hasText("offsite agenda", substring = true)).fetchSemanticsNodes().isNotEmpty())
        // a shake shows it
        engine.reveal = true
        waitUntil(timeoutMillis = 3000) { onAllNodes(hasText("Send the offsite agenda", substring = true)).fetchSemanticsNodes().isNotEmpty() }
    }

    @Test fun theMenuOpensASavedSearch() = sample {
        onNodeWithContentDescription("Menu").performClick()
        waitUntil(timeoutMillis = 3000) { onAllWithText("My open tasks").isNotEmpty() }
        onNodeWithText("My open tasks", useUnmergedTree = true).performClick()
        waitUntil(timeoutMillis = 3000) { onAllWithText("Book the offsite venue").isNotEmpty() }
    }

    @Test fun aMeetingOpensItsPage() = sample {
        onNode(hasText("Design review", substring = true)).performClick()
        waitUntil(timeoutMillis = 3000) { onAllNodes(hasContentDescription("Back")).fetchSemanticsNodes().isNotEmpty() }
        onNodeWithText("Design review", useUnmergedTree = true).assertExists()
    }

    // a row of a page opens its own page on top (found on the Galaxy: a meeting's document did not open)
    @Test fun aMeetingsDocumentOpensOnTop() = sample {
        onNode(hasText("Design review", substring = true)).performClick()
        waitUntil(timeoutMillis = 3000) { onAllWithText("Offsite planning").isNotEmpty() }
        onNode(hasText("Offsite planning") and androidx.compose.ui.test.hasClickAction()).performClick()
        waitUntil(timeoutMillis = 3000) { onAllNodes(hasText("Offsite planning") and androidx.compose.ui.test.hasClickAction()).fetchSemanticsNodes().isEmpty() }
    }

    @Test fun askTanaOpensTheChat() = sample {
        val field = onNode(hasContentDescription("Ask Tana") and androidx.compose.ui.test.hasSetTextAction())
        field.performClick()
        field.performTextInput("Summarise this week")
        onNode(hasContentDescription("Ask Tana") and androidx.compose.ui.test.hasSetTextAction().not() and androidx.compose.ui.test.hasClickAction()).performClick()
        waitUntil(timeoutMillis = 5000) { onAllWithText("Summarise this week’s meetings").isNotEmpty() }
    }

    @Test fun quickAddWaitsForATitle() = sample {
        onNodeWithContentDescription("Quick Add Task").performClick()
        waitUntil(timeoutMillis = 3000) { onAllWithText("Quick Add").isNotEmpty() }
        onNodeWithText("Add").assertIsNotEnabled()
        onNodeWithText("Cancel").performClick()
        waitUntil(timeoutMillis = 3000) { onAllWithText("Quick Add").isEmpty() }
    }

    @Test fun settingsOpenFromTheMenu() = sample {
        onNodeWithContentDescription("Menu").performClick()
        onNodeWithContentDescription("Settings").performClick()
        waitUntil(timeoutMillis = 3000) { onAllWithText("Demo mode").isNotEmpty() }
        onNodeWithContentDescription("Close").performClick()
        waitUntil(timeoutMillis = 3000) { onAllWithText("Demo mode").isEmpty() }
    }

    @Test fun aLongPressOffersTheNodesActions() = sample {
        onNode(hasText("Draft the Q4 hiring plan") and androidx.compose.ui.test.hasClickAction()).performTouchInput { longClick() }
        waitUntil(timeoutMillis = 3000) { onAllWithText("Pin to Today").isNotEmpty() }
        listOf("Assign to …", "Mark as Sensitive", "Delete").forEach { onNodeWithText(it).assertExists() }
    }

    @Test fun aWideWindowKeepsTheMenuBesideThePage() = sample(1280, 800) {
        onNodeWithText("My open tasks", useUnmergedTree = true).assertExists()
        assertTrue(onAllNodes(hasContentDescription("Menu")).fetchSemanticsNodes().isEmpty())
    }
}
