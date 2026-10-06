import XCTest

// The widgets end to end, on the simulator's own home screen (ios/Widgets): the app opened on its invented content keeps
// what they show, the widget is added as a person adds one (edit the home screen, Add Widget, Orbital), and used there.
// SpringBoard is another app: it is driven by the labels it gives VoiceOver, and a step that cannot find what it looks
// for prints what SpringBoard has on screen.
final class WidgetTests: XCTestCase {
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private var app: XCUIApplication!
    // Set by the first test that finds this build cannot show what a widget holds (add): the rest skip at once, before
    // launching the app or adding a widget, where each took a minute to reach the same skip (npm run phones signs ad hoc,
    // so it runs them; a build with signing off still skips)
    private static var unsigned = false
    private static let why = "the widget is added and drawn; what it shows needs a signed build (Keychain group), which one with signing off has not"

    override func setUpWithError() throws {
        if Self.unsigned { throw XCTSkip(Self.why) }
        continueAfterFailure = false
        executionTimeAllowance = 240 // the gallery's first listing on a new simulator (add) on top of the minute a test takes
        XCUIDevice.shared.orientation = .portrait
        app = XCUIApplication()
        app.launchArguments = ["-sample", "-demoMode", "NO"]
        app.launch()
        XCTAssert(app.navigationBars["Timeline"].waitForExistence(timeout: 15))
        sleep(2) // the widgets' Timeline is left once the sample is on screen (Engine.keepGlimpse)
        XCUIDevice.shared.press(.home)
    }

    private func found(_ element: XCUIElement, _ what: String, timeout: TimeInterval = 15) -> XCUIElement {
        if !element.waitForExistence(timeout: timeout) { XCTFail("no " + what + " on the home screen:\n" + springboard.debugDescription) }
        return element
    }

    // edit the home screen, Add Widget, Orbital, the gallery's page for the widget (Today's Tasks small, medium and large,
    // then Today's Tasks and Upcoming Meetings medium and large, then Activity medium and large), Add Widget, Done
    private func add(page: Int) throws {
        // A new simulator's gallery lists a newly installed app's widgets only minutes later (npm run phones runs these
        // on the checkout's own simulator, which keeps Orbital, for that), and a gallery once open does not update:
        // closed and opened again until Orbital is in it
        let orbital = springboard.cells.containing(.staticText, identifier: "Orbital").firstMatch
        let until = Date.now.addingTimeInterval(150)
        while true {
            springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).press(forDuration: 1.6)
            found(springboard.buttons["Edit"], "Edit").tap()
            found(springboard.buttons["Add Widget"], "Add Widget in the Edit menu").tap()
            let search = found(springboard.searchFields.firstMatch, "the widget search")
            search.tap()
            search.typeText("Orbital")
            if orbital.waitForExistence(timeout: 10) || Date.now > until { break }
            XCUIDevice.shared.press(.home) // the gallery closed
            XCUIDevice.shared.press(.home) // and the home screen's editing
            sleep(5)
        }
        found(orbital, "Orbital among the widgets").tap()
        let preview = found(springboard.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Orbital,'")).firstMatch, "the widget's preview")
        for _ in 0..<page { preview.swipeLeft() }
        found(springboard.buttons.matching(NSPredicate(format: "label CONTAINS 'Add Widget'")).firstMatch, "the gallery's Add Widget").tap()
        if springboard.buttons["Done"].waitForExistence(timeout: 5) { springboard.buttons["Done"].tap() }
        // The app leaves what a widget shows in its Keychain group (Engine.keepGlimpse), which a build with signing off
        // (CODE_SIGNING_ALLOWED=NO, as CI builds) has none of: the widget is there and drawn, saying where to start
        if springboard.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Open Orbital to see'")).firstMatch.waitForExistence(timeout: 5),
           !springboard.buttons.containing(NSPredicate(format: "label CONTAINS 'Draft the Q4 hiring plan'")).firstMatch.exists {
            Self.unsigned = true
            throw XCTSkip(Self.why)
        }
    }

    func testTodaysTasksAndATapOpensTheTask() throws {
        try add(page: 1) // medium: a row a link of its own
        let task = found(springboard.buttons.containing(NSPredicate(format: "label CONTAINS 'Draft the Q4 hiring plan'")).firstMatch, "the widget's task")
        XCTAssertFalse(springboard.staticTexts["Send the offsite agenda"].exists, "a sensitive task's words are not on a widget")
        task.tap()
        XCTAssert(app.wait(for: .runningForeground, timeout: 15), "the task opens in the app")
    }

    // a task's box opens the app, which ticks it at once: its box in the app says Completed
    func testATasksBoxOnTheWidgetTicksItInTheApp() throws {
        try add(page: 1)
        // the first: a widget added by an earlier run may still be on the home screen
        found(springboard.buttons.matching(NSPredicate(format: "label == %@", "Mark as done, Draft the Q4 hiring plan")).firstMatch, "the task's box").tap()
        XCTAssert(app.wait(for: .runningForeground, timeout: 15), "the app opens")
        let ticked = app.buttons.matching(NSPredicate(format: "label == %@ AND value == %@", "Draft the Q4 hiring plan", "Completed")).firstMatch
        XCTAssert(ticked.waitForExistence(timeout: 15), "the task ticked in the app")
    }

    func testAMeetingOnTheTodayWidgetOpensInTheApp() throws {
        try add(page: 4) // large: Design review, a meeting to come with a document, is on it
        XCTAssertFalse(springboard.buttons["Show documents"].exists, "nothing opens in place: a widget does not expand")
        found(springboard.buttons.containing(NSPredicate(format: "label CONTAINS 'Design review'")).firstMatch, "the meeting").tap()
        XCTAssert(app.wait(for: .runningForeground, timeout: 15))
        // the meeting's own page: written up, it opens on its Summary (Pages.swift), with Notes beside it
        if !app.navigationBars["Design review"].waitForExistence(timeout: 15) || !app.buttons["Summary"].exists {
            XCTFail("the meeting open in the app, on its page:\n" + app.debugDescription)
        }
    }
}
