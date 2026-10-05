import XCTest

// The app on its invented content (-sample: timeline-sample.json and pages-sample.json, no Tana, nothing written),
// driven as a finger is: every element is found by the label the app gives VoiceOver, so a test that cannot find
// something is also a screen VoiceOver cannot read.
final class SampleTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        app = XCUIApplication()
        // -demoMode NO: Settings' Demo mode is kept in UserDefaults and makes a box do nothing; the argument overrides
        // what a simulator kept from an earlier run, for this launch only
        app.launchArguments = ["-sample", "-demoMode", "NO"]
        app.launch()
        XCTAssert(app.navigationBars["Timeline"].waitForExistence(timeout: 15))
    }

    // A task's box: its words as the label and its state as the value (TaskBox); the words beside it are a second
    // button with the same label that opens the task
    private func box(_ words: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@ AND value IN %@", words, ["Completed", "Not completed", "In your Inbox"])).firstMatch
    }

    // Every wait gives up after 15 s: a CI simulator once took longer than 5 to tick a box, and a wait that is met
    // returns at once, so the limit only lengthens a run that fails
    private func wait(_ element: XCUIElement, value: String) {
        let done = expectation(for: NSPredicate(format: "value == %@", value), evaluatedWith: element)
        wait(for: [done], timeout: 15)
    }

    func testTimelineShowsTodaysTasks() {
        XCTAssertEqual(box("Draft the Q4 hiring plan").value as? String, "Not completed")
        XCTAssertEqual(box("Review the design crit notes").value as? String, "Completed")
    }

    func testTickingATaskOffAndBackOn() {
        let draft = box("Draft the Q4 hiring plan")
        draft.tap()
        wait(draft, value: "Completed")
        draft.tap()
        wait(draft, value: "Not completed")
    }

    // what VoiceOver reads is the buttons: the words still sit in the tree as a Text inside the hidden one (Blur), where
    // only a test, never VoiceOver, reaches them
    func testSensitiveTaskShowsNoWords() {
        XCTAssert(box("Sensitive task").exists)
        XCTAssert(app.buttons["Sensitive, shake or use Settings to show"].exists)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label CONTAINS 'offsite agenda'")).firstMatch.exists)
    }

    func testMenuOpensASavedSearch() {
        app.buttons["Menu"].tap()
        app.buttons["My open tasks"].tap()
        // a saved search's page is untitled (NodeScreen titled: false): its rows say which it is
        XCTAssert(app.buttons.matching(NSPredicate(format: "label CONTAINS 'Book the offsite venue'")).firstMatch.waitForExistence(timeout: 15))
        XCTAssertFalse(app.navigationBars["Timeline"].exists)
    }

    func testMeetingOpensItsPage() {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Design review'")).firstMatch.tap()
        XCTAssert(app.navigationBars["Design review"].waitForExistence(timeout: 15))
    }

    func testAskTanaOpensTheChat() {
        let field = app.textFields["Ask Tana"]
        field.tap()
        field.typeText("Summarise this week")
        app.buttons["Ask Tana"].tap()
        XCTAssert(app.navigationBars["Summarise this week’s meetings"].waitForExistence(timeout: 15))
    }

    func testQuickAddWaitsForATitle() {
        app.buttons["Quick Add Task"].tap()
        let sheet = app.navigationBars["Quick Add"]
        XCTAssert(sheet.waitForExistence(timeout: 15))
        XCTAssertFalse(sheet.buttons["Add"].isEnabled)
        XCTAssertEqual(app.switches["Pin to today"].value as? String, "0", "Pin to today is there, and off until turned on")
        // closed by Cancel only: a swipe down leaves it where it is
        sheet.swipeDown(velocity: .fast)
        XCTAssertFalse(sheet.waitForNonExistence(timeout: 2))
        sheet.buttons["Cancel"].tap()
        XCTAssert(sheet.waitForNonExistence(timeout: 15))
    }

    // Add closes Quick Add at once, the task made behind it; one Tana did not take (the sample saves nothing) is back,
    // words and all, the next time Quick Add opens, with why
    func testQuickAddClosesAtOnceAndKeepsWhatWasNotAdded() {
        app.buttons["Quick Add Task"].tap()
        let sheet = app.navigationBars["Quick Add"]
        XCTAssert(sheet.waitForExistence(timeout: 15))
        app.textFields["New task"].tap()
        app.textFields["New task"].typeText("Call the venue")
        sheet.buttons["Add"].tap()
        XCTAssert(sheet.waitForNonExistence(timeout: 15))
        XCTAssert(app.navigationBars["Timeline"].exists)
        app.buttons["Quick Add Task"].tap()
        XCTAssert(sheet.waitForExistence(timeout: 15))
        XCTAssert(app.staticTexts["Not added: The sample saves nothing"].waitForExistence(timeout: 15))
        // with words in it the field is a text view to XCUITest, so it is found by what it holds
        XCTAssert(app.descendants(matching: .any).matching(NSPredicate(format: "value == %@", "Call the venue")).firstMatch.exists)
        sheet.buttons["Cancel"].tap()
    }

    // Siri and Shortcuts' Add Task (Intents.swift) opens orbital:new, and the app makes the task at once; one Tana did not
    // take (the sample saves nothing) is back in the next Quick Add as it was asked for, pinned to today included. The link
    // comes in as -open: one opened from outside the app asks first whether to open Orbital, which the test would wait on.
    func testAddTaskFromSiriIsMadeAsAskedPinnedToToday() {
        app.terminate()
        app.launchArguments = ["-sample", "-demoMode", "NO", "-open", "orbital:new?title=Book%20the%20train&today=1"]
        app.launch()
        XCTAssert(app.navigationBars["Timeline"].waitForExistence(timeout: 15))
        sleep(1) // the task is made behind the Timeline, and refused by the sample, a moment after the link opens
        app.buttons["Quick Add Task"].tap()
        let sheet = app.navigationBars["Quick Add"]
        XCTAssert(sheet.waitForExistence(timeout: 15))
        XCTAssert(app.staticTexts["Not added: The sample saves nothing"].waitForExistence(timeout: 15), "the task was made, and the sample refused it")
        XCTAssert(app.descendants(matching: .any).matching(NSPredicate(format: "value == %@", "Book the train")).firstMatch.exists)
        XCTAssertEqual(app.switches["Pin to today"].value as? String, "1", "pinned to today, as Siri was asked")
        sheet.buttons["Cancel"].tap()
    }

    func testSettingsOpenFromTheMenu() {
        app.buttons["Menu"].tap()
        app.buttons["Settings"].tap()
        XCTAssert(app.staticTexts["Demo mode"].waitForExistence(timeout: 15))
        app.buttons["Close"].tap()
        XCTAssert(app.staticTexts["Demo mode"].waitForNonExistence(timeout: 15))
    }

    func testLandscapeKeepsTimelineMenuAndSavedSearch() {
        defer { XCUIDevice.shared.orientation = .portrait }
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssert(app.navigationBars["Timeline"].waitForExistence(timeout: 15))
        XCTAssert(box("Draft the Q4 hiring plan").exists)

        app.buttons["Menu"].tap()
        XCTAssert(app.buttons["My open tasks"].waitForExistence(timeout: 15))
        app.buttons["My open tasks"].tap()
        let offsite = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Book the offsite venue'")).firstMatch
        XCTAssert(offsite.waitForExistence(timeout: 15))

        XCUIDevice.shared.orientation = .landscapeRight
        XCTAssert(offsite.exists)

        XCUIDevice.shared.orientation = .portrait
        XCTAssert(offsite.waitForExistence(timeout: 15))
    }

    func testLandscapeKeepsTaskDetailsThroughRotation() {
        defer { XCUIDevice.shared.orientation = .portrait }
        XCUIDevice.shared.orientation = .landscapeLeft
        let designReview = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Design review'")).firstMatch
        XCTAssert(designReview.waitForExistence(timeout: 15))
        designReview.tap()
        XCTAssert(app.navigationBars["Design review"].waitForExistence(timeout: 15))

        XCUIDevice.shared.orientation = .landscapeRight
        XCTAssert(app.navigationBars["Design review"].waitForExistence(timeout: 15))
        XCUIDevice.shared.orientation = .portrait
        XCTAssert(app.navigationBars["Design review"].waitForExistence(timeout: 15))
    }

    func testLandscapeKeepsComposerAndSheetsUsable() {
        defer { XCUIDevice.shared.orientation = .portrait }
        XCUIDevice.shared.orientation = .landscapeLeft
        let composer = app.textFields["Ask Tana"]
        composer.tap()
        composer.typeText("Prepare the landscape review")
        XCTAssert(app.buttons["Ask Tana"].exists)

        XCUIDevice.shared.orientation = .landscapeRight
        XCTAssert(app.buttons["Ask Tana"].exists)

        app.buttons["Quick Add Task"].tap()
        let quickAdd = app.navigationBars["Quick Add"]
        XCTAssert(quickAdd.waitForExistence(timeout: 15))
        let title = app.textFields["New task"]
        title.tap()
        title.typeText("Review landscape layout")
        XCTAssert(quickAdd.buttons["Add"].isEnabled)
        quickAdd.buttons["Cancel"].tap()
        XCTAssert(quickAdd.waitForNonExistence(timeout: 15))

        app.buttons["Menu"].tap()
        app.buttons["Settings"].tap()
        XCTAssert(app.buttons["Close"].waitForExistence(timeout: 15))
        app.buttons["Close"].tap()
        XCTAssert(app.navigationBars["Timeline"].waitForExistence(timeout: 15))

        XCUIDevice.shared.orientation = .portrait
        XCTAssert(app.navigationBars["Timeline"].waitForExistence(timeout: 15))
    }

    // Settings' Show sensitive items shows what a shake shows, for an iPhone that cannot be shaken
    // (-settings: open at the start; from the menu, the menu would still cover the page once it closes)
    func testSettingsShowSensitiveItems() {
        app.terminate()
        app.launchArguments.append("-settings")
        app.launch()
        let show = app.switches["Show sensitive items"]
        XCTAssert(show.waitForExistence(timeout: 5))
        show.switches.firstMatch.tap()
        app.buttons["Close"].tap()
        XCTAssert(app.buttons.matching(NSPredicate(format: "label CONTAINS 'offsite agenda'")).firstMatch.waitForExistence(timeout: 5))
    }

    // Settings' Agents has Connect your personal agent (Agents.swift): the ? beside Add both plugins opens the help with
    // ChatGPT's plugins, and the sample, which saves nothing, asks the relay for no code and says so, with Try again
    func testConnectToYourDotFromSettings() {
        app.terminate()
        app.launchArguments.append("-settings")
        app.launch()
        let connect = app.buttons["Connect your personal agent"]
        XCTAssert(connect.waitForExistence(timeout: 5))
        connect.tap()
        XCTAssert(app.staticTexts["The sample saves nothing"].waitForExistence(timeout: 5))
        XCTAssert(app.buttons["Try again"].exists)
        app.buttons["Help"].tap()
        XCTAssert(app.descendants(matching: .any)["Open ChatGPT plugins"].waitForExistence(timeout: 5)) // a Link: neither a button nor a link to XCUITest everywhere
    }
}
