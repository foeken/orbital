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

    private func wait(_ element: XCUIElement, value: String) {
        let done = expectation(for: NSPredicate(format: "value == %@", value), evaluatedWith: element)
        wait(for: [done], timeout: 5)
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
        XCTAssert(app.buttons["Sensitive, shake to show"].exists)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label CONTAINS 'offsite agenda'")).firstMatch.exists)
    }

    func testMenuOpensASavedSearch() {
        app.buttons["Menu"].tap()
        app.buttons["My open tasks"].tap()
        // a saved search's page is untitled (NodeScreen titled: false): its rows say which it is
        XCTAssert(app.buttons.matching(NSPredicate(format: "label CONTAINS 'Book the offsite venue'")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars["Timeline"].exists)
    }

    func testMeetingOpensItsPage() {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Design review'")).firstMatch.tap()
        XCTAssert(app.navigationBars["Design review"].waitForExistence(timeout: 5))
    }

    func testAskTanaOpensTheChat() {
        let field = app.textFields["Ask Tana"]
        field.tap()
        field.typeText("Summarise this week")
        app.buttons["Ask Tana"].tap()
        XCTAssert(app.navigationBars["Summarise this week’s meetings"].waitForExistence(timeout: 5))
    }

    func testQuickAddWaitsForATitle() {
        app.buttons["Quick Add Task"].tap()
        let sheet = app.navigationBars["Quick Add"]
        XCTAssert(sheet.waitForExistence(timeout: 5))
        XCTAssertFalse(sheet.buttons["Add"].isEnabled)
        sheet.buttons["Cancel"].tap()
        XCTAssert(sheet.waitForNonExistence(timeout: 5))
    }

    func testSettingsOpenFromTheMenu() {
        app.buttons["Menu"].tap()
        app.buttons["Settings"].tap()
        XCTAssert(app.staticTexts["Demo mode"].waitForExistence(timeout: 5))
        app.buttons["Close"].tap()
        XCTAssert(app.staticTexts["Demo mode"].waitForNonExistence(timeout: 5))
    }

    func testLandscapeKeepsTimelineMenuAndSavedSearch() {
        defer { XCUIDevice.shared.orientation = .portrait }
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssert(app.navigationBars["Timeline"].waitForExistence(timeout: 5))
        XCTAssert(box("Draft the Q4 hiring plan").exists)

        app.buttons["Menu"].tap()
        XCTAssert(app.buttons["My open tasks"].waitForExistence(timeout: 5))
        app.buttons["My open tasks"].tap()
        let offsite = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Book the offsite venue'")).firstMatch
        XCTAssert(offsite.waitForExistence(timeout: 5))

        XCUIDevice.shared.orientation = .landscapeRight
        XCTAssert(offsite.exists)

        XCUIDevice.shared.orientation = .portrait
        XCTAssert(offsite.waitForExistence(timeout: 5))
    }

    func testLandscapeKeepsTaskDetailsThroughRotation() {
        defer { XCUIDevice.shared.orientation = .portrait }
        XCUIDevice.shared.orientation = .landscapeLeft
        let designReview = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Design review'")).firstMatch
        XCTAssert(designReview.waitForExistence(timeout: 5))
        designReview.tap()
        XCTAssert(app.navigationBars["Design review"].waitForExistence(timeout: 5))

        XCUIDevice.shared.orientation = .landscapeRight
        XCTAssert(app.navigationBars["Design review"].waitForExistence(timeout: 5))
        XCUIDevice.shared.orientation = .portrait
        XCTAssert(app.navigationBars["Design review"].waitForExistence(timeout: 5))
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
        XCTAssert(quickAdd.waitForExistence(timeout: 5))
        let title = app.textFields["New task"]
        title.tap()
        title.typeText("Review landscape layout")
        XCTAssert(quickAdd.buttons["Add"].isEnabled)
        quickAdd.buttons["Cancel"].tap()
        XCTAssert(quickAdd.waitForNonExistence(timeout: 5))

        app.buttons["Menu"].tap()
        app.buttons["Settings"].tap()
        XCTAssert(app.buttons["Close"].waitForExistence(timeout: 5))
        app.buttons["Close"].tap()
        XCTAssert(app.navigationBars["Timeline"].waitForExistence(timeout: 5))

        XCUIDevice.shared.orientation = .portrait
        XCTAssert(app.navigationBars["Timeline"].waitForExistence(timeout: 5))
    }
}
