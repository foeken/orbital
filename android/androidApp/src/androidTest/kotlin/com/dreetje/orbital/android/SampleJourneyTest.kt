package com.dreetje.orbital.android

import android.content.Intent
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasStateDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

// The app on a device, on the iPhone's invented content (sample=true: no Tana, nothing written), driven as a finger
// is: the iPhone's SampleTests case for case, and what only Android has (the system's Back, a rotation, the share
// sheet). Everything is found by what TalkBack reads.
@RunWith(AndroidJUnit4::class)
class SampleJourneyTest {
    @get:Rule val compose = createEmptyComposeRule()
    private var scenario: ActivityScenario<MainActivity>? = null
    private val device get() = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    private fun launch(edit: Intent.() -> Unit = {}) {
        awake(device)
        val intent = Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java).putExtra("sample", true).putExtra("demoMode", false).apply(edit)
        scenario = ActivityScenario.launch(intent)
        compose.waitUntil(15_000) { seen("Today's Tasks") }
    }

    @After fun close() { scenario?.close() }

    // on screen; while one screen hands over to another (a share bringing Orbital forward) there is briefly none to ask,
    // which is not yet rather than a failure
    private fun seen(text: String) = runCatching { compose.onAllNodes(hasText(text, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }.getOrDefault(false)
    // a phone's menu is behind its button; a tablet's stays beside the page and has none
    private fun openMenu() {
        if (compose.onAllNodes(hasContentDescription("Menu")).fetchSemanticsNodes().isNotEmpty()) compose.onNodeWithContentDescription("Menu").performClick()
    }
    private val home get() = compose.onAllNodes(hasContentDescription("Menu") or hasContentDescription("Quick Add Task")).fetchSemanticsNodes().isNotEmpty()
    private fun box(words: String): SemanticsNodeInteraction = compose.onNode(hasContentDescription(words) and (hasStateDescription("Completed") or hasStateDescription("Not completed") or hasStateDescription("In your Inbox")))

    @Test fun theTimelineShowsTodaysTasks() {
        launch()
        box("Draft the Q4 hiring plan").assert(hasStateDescription("Not completed"))
        box("Review the design crit notes").assert(hasStateDescription("Completed"))
    }

    @Test fun tickingATaskOffAndBackOn() {
        launch()
        val draft = box("Draft the Q4 hiring plan")
        draft.performClick()
        compose.waitUntil(3000) { runCatching { draft.assert(hasStateDescription("Completed")) }.isSuccess }
        draft.performClick()
        compose.waitUntil(3000) { runCatching { draft.assert(hasStateDescription("Not completed")) }.isSuccess }
    }

    @Test fun aSensitiveTaskShowsNoWords() {
        launch()
        box("Sensitive task").assertExists()
        compose.onAllNodes(hasContentDescription("Sensitive, shake to show")).fetchSemanticsNodes().isNotEmpty().let(::check)
        // what TalkBack is given (the system's accessibility tree, as UI Automator reads it) has no words of it; the
        // words still sit, transparent, under the bars, where only a test of Compose's own tree reaches them
        check(compose.onAllNodes(hasText("offsite agenda", substring = true)).fetchSemanticsNodes().isEmpty())
        check(device.findObject(androidx.test.uiautomator.By.textContains("offsite agenda")) == null)
        check(device.findObject(androidx.test.uiautomator.By.descContains("offsite agenda")) == null)
    }

    @Test fun theMenuOpensASavedSearch() {
        launch()
        openMenu()
        compose.waitUntil(5000) { seen("My open tasks") }
        compose.onNodeWithText("My open tasks", useUnmergedTree = true).performClick()
        compose.waitUntil(5000) { seen("Book the offsite venue") }
    }

    @Test fun aMeetingOpensItsPageAndBackComesHome() {
        launch()
        compose.onNode(hasText("Design review", substring = true) and hasClickAction()).performClick()
        compose.waitUntil(5000) { compose.onAllNodes(hasContentDescription("Back")).fetchSemanticsNodes().isNotEmpty() }
        device.pressBack() // the system's Back, as the gesture sends it
        compose.waitUntil(5000) { home && compose.onAllNodes(hasContentDescription("Back")).fetchSemanticsNodes().isEmpty() }
    }

    @Test fun aRotationKeepsThePageOpen() {
        launch()
        compose.onNode(hasText("Design review", substring = true) and hasClickAction()).performClick()
        compose.waitUntil(5000) { compose.onAllNodes(hasContentDescription("Back")).fetchSemanticsNodes().isNotEmpty() }
        scenario!!.recreate()
        compose.waitUntil(5000) { compose.onAllNodes(hasContentDescription("Back")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Design review", useUnmergedTree = true).assertExists()
    }

    @Test fun askTanaOpensTheChat() {
        launch()
        val field = compose.onNode(hasContentDescription("Ask Tana") and hasSetTextAction())
        field.performClick()
        field.performTextInput("Summarise this week")
        compose.onNode(hasContentDescription("Ask Tana") and hasSetTextAction().not() and hasClickAction()).performClick()
        compose.waitUntil(10_000) { seen("Summarise this week’s meetings") }
    }

    @Test fun quickAddWaitsForATitle() {
        launch()
        compose.onNodeWithContentDescription("Quick Add Task").performClick()
        compose.waitUntil(5000) { seen("Quick Add") }
        compose.onNodeWithText("Add").assertIsNotEnabled()
        compose.onNodeWithText("Cancel").performClick()
        compose.waitUntil(5000) { !seen("Quick Add") }
    }

    @Test fun settingsOpenFromTheMenu() {
        launch()
        openMenu()
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.waitUntil(5000) { seen("Demo mode") }
        compose.onNodeWithContentDescription("Close").performClick()
        compose.waitUntil(5000) { !seen("Demo mode") }
    }

    @Test fun aLongPressOffersTheNodesActions() {
        launch()
        compose.onNode(hasText("Draft the Q4 hiring plan") and hasClickAction()).performTouchInput { longClick() }
        compose.waitUntil(5000) { seen("Pin to Today") }
        listOf("Assign to …", "Mark as Sensitive", "Delete").forEach { compose.onNodeWithText(it).assertExists() }
    }

    // shared from another app (the iPhone's Share extension): ShareActivity leaves the words and brings this Orbital
    // forward, its subject and text a line each, on Quick Add
    @Test fun sharedWordsOpenQuickAdd() {
        launch()
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        context.startActivity(Intent(context, ShareActivity::class.java).setAction(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_SUBJECT, "Offsite venue").putExtra(Intent.EXTRA_TEXT, "Call the venue about Thursday").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        compose.waitUntil(10_000) { seen("Quick Add") && seen("Offsite venue\nCall the venue about Thursday") }
    }
}

// A phone on a desk turns its screen off between tests, and a test on a dark or locked screen finds no window: woken,
// kept on while plugged in, and the keyguard dismissed (a PIN still needs the person holding it)
fun awake(device: UiDevice) {
    device.wakeUp()
    device.executeShellCommand("svc power stayon usb")
    device.executeShellCommand("wm dismiss-keyguard")
}
