package com.dreetje.orbital.android

import android.content.Intent
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.click
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertTrue
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

    @Test fun taskCheckboxHasA48DpTargetAndAcceptsATapOutsideTheVisibleBox() {
        launch()
        val draft = box("Draft the Q4 hiring plan")
        val bounds = draft.fetchSemanticsNode().boundsInRoot
        val minimumTarget = with(compose.density) { 48.dp.toPx() }
        assertTrue("Task checkbox needs a 48dp hit target", bounds.width >= minimumTarget && bounds.height >= minimumTarget)
        draft.performTouchInput {
            click(Offset(center.x, center.y - with(density) { 20.dp.toPx() }))
        }
        compose.waitUntil(3000) { runCatching { draft.assert(hasStateDescription("Completed")) }.isSuccess }
    }

    @Test fun aSensitiveTaskShowsNoWords() {
        launch()
        box("Sensitive task").assertExists()
        compose.onAllNodes(hasContentDescription(com.dreetje.orbital.ui.SENSITIVE_LABEL)).fetchSemanticsNodes().isNotEmpty().let(::check)
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

    // a long press picks a saved search up and it follows the finger, as the iPhone's List reorders: the one under it
    // makes way. Whatever order an earlier run left, the top two change places.
    @Test fun savedSearchesReorderByDragging() {
        launch()
        openMenu()
        compose.waitUntil(5000) { seen("My open tasks") }
        compose.waitForIdle()
        // the menu's rows start where its own Timeline row's words do; on a wide window the page beside it says Timeline too
        val timeline = compose.onAllNodes(hasText("Timeline"), useUnmergedTree = true).fetchSemanticsNodes().minBy { it.boundsInRoot.left }.boundsInRoot
        val searches = compose.onAllNodes(hasText("", substring = true), useUnmergedTree = true).fetchSemanticsNodes()
            .mapNotNull { n -> n.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text?.let { t -> Triple(t, n.boundsInRoot.left, n.boundsInRoot.top) } }
            .filter { (_, left, top) -> kotlin.math.abs(left - timeline.left) < 2f && top > timeline.bottom }
            .map { (t, _, top) -> t to top }
            .sortedBy { it.second }
        val (first, second) = searches[0].first to searches[1].first
        val step = searches[1].second - searches[0].second
        compose.onNodeWithText(first, useUnmergedTree = true).performTouchInput {
            down(center)
            advanceEventTime(viewConfiguration.longPressTimeoutMillis + 200)
            repeat(10) { moveBy(Offset(0f, step * 0.12f)) }
            up()
        }
        compose.waitForIdle()
        val top = { t: String -> compose.onNodeWithText(t, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.top }
        assertTrue("$second should now be above $first", top(second) < top(first))
    }

    @Test fun aMeetingOpensItsPageAndBackComesHome() {
        launch()
        compose.onNode(hasText("Design review", substring = true) and hasClickAction()).performClick()
        compose.waitUntil(5000) { compose.onAllNodes(hasContentDescription("Back")).fetchSemanticsNodes().isNotEmpty() }
        device.pressBack() // the system's Back, as the gesture sends it
        compose.waitUntil(5000) { home && compose.onAllNodes(hasContentDescription("Back")).fetchSemanticsNodes().isEmpty() }
    }

    @Test fun predictiveEdgeBackReturnsFromANodeToItsPreviousPage() {
        launch()
        compose.onNode(hasText("Design review", substring = true) and hasClickAction()).performClick()
        compose.waitUntil(5000) { compose.onAllNodes(hasContentDescription("Back")).fetchSemanticsNodes().isNotEmpty() }
        val y = device.displayHeight / 2
        device.executeShellCommand("input swipe 0 $y ${device.displayWidth * 3 / 4} $y 450")
        compose.waitUntil(5000) { home && compose.onAllNodes(hasContentDescription("Back")).fetchSemanticsNodes().isEmpty() }
    }

    @Test fun rightEdgePredictiveBackReturnsFromANodeToItsPreviousPage() {
        launch()
        compose.onNode(hasText("Design review", substring = true) and hasClickAction()).performClick()
        compose.waitUntil(5000) { compose.onAllNodes(hasContentDescription("Back")).fetchSemanticsNodes().isNotEmpty() }
        val y = device.displayHeight / 2
        device.executeShellCommand("input swipe ${device.displayWidth - 1} $y ${device.displayWidth / 4} $y 450")
        compose.waitUntil(5000) { home && compose.onAllNodes(hasContentDescription("Back")).fetchSemanticsNodes().isEmpty() }
    }

    @Test fun cancelledPredictiveBackKeepsTheCurrentPageOpen() {
        launch()
        compose.onNode(hasText("Design review", substring = true) and hasClickAction()).performClick()
        compose.waitUntil(5000) { compose.onAllNodes(hasContentDescription("Back")).fetchSemanticsNodes().isNotEmpty() }
        // a back swipe is taken back by bringing the finger to the edge again before letting go; let go anywhere past
        // the start, the system goes back
        val y = device.displayHeight / 2
        val w = device.displayWidth
        device.swipe(arrayOf(android.graphics.Point(1, y), android.graphics.Point(w * 3 / 8, y), android.graphics.Point(1, y)), 40)
        Thread.sleep(1500) // the page settles home
        compose.waitUntil(3000) { compose.onAllNodes(hasContentDescription("Back")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Design review", useUnmergedTree = true).assertExists()
    }

    @Test fun predictiveBackClosesTheOpenCompactMenu() {
        launch()
        if (compose.onAllNodes(hasContentDescription("Menu")).fetchSemanticsNodes().isEmpty()) return // a wide window's menu stays beside the page
        openMenu()
        compose.waitUntil(5000) { seen("My open tasks") }
        val y = device.displayHeight / 2
        device.executeShellCommand("input swipe ${device.displayWidth - 1} $y ${device.displayWidth / 2} $y 450")
        compose.waitUntil(5000) {
            compose.onAllNodes(hasContentDescription("Menu")).fetchSemanticsNodes().isNotEmpty() &&
                compose.onAllNodes(hasText("My open tasks", substring = true)).fetchSemanticsNodes().isEmpty()
        }
    }

    @Test fun aRotationKeepsThePageOpen() {
        launch()
        compose.onNode(hasText("Design review", substring = true) and hasClickAction()).performClick()
        compose.waitUntil(5000) { compose.onAllNodes(hasContentDescription("Back")).fetchSemanticsNodes().isNotEmpty() }
        scenario!!.recreate()
        compose.waitUntil(5000) { compose.onAllNodes(hasContentDescription("Back")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Design review", useUnmergedTree = true).assertExists()
    }

    // a wide window (a tablet, an unfolded phone) keeps the menu beside the page; a phone's is behind its button
    @Test fun aWideWindowKeepsTheMenuBesideThePage() {
        val metrics = InstrumentationRegistry.getInstrumentation().targetContext.resources.displayMetrics
        val wide = metrics.widthPixels / metrics.density >= 840f
        launch()
        assertTrue(compose.onAllNodes(hasContentDescription("Menu")).fetchSemanticsNodes().isEmpty() == wide)
        if (wide) compose.onNodeWithText("My open tasks", useUnmergedTree = true).assertExists()
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

    // Settings' Show sensitive items shows what a shake shows, for a phone that cannot be shaken
    @Test fun settingsShowSensitiveItems() {
        launch { putExtra("settings", true) } // open at the start: from the menu, the menu would still cover the page
        compose.waitUntil(5000) { seen("Show sensitive items") }
        compose.onNodeWithContentDescription("Show sensitive items").performClick()
        compose.onNodeWithContentDescription("Close").performClick()
        compose.waitUntil(5000) { seen("Send the offsite agenda") }
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
