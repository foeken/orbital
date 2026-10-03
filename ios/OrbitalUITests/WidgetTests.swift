import XCTest

// The widgets end to end, on the simulator's own home screen (ios/Widgets): the app opened on its invented content keeps
// what they show, the widget is added as a person adds one (edit the home screen, Add Widget, Orbital), and used there.
// SpringBoard is another app: it is driven by the labels it gives VoiceOver, and a step that cannot find what it looks
// for prints what SpringBoard has on screen.
final class WidgetTests: XCTestCase {
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
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
    // then the Timeline), Add Widget, Done
    private func add(page: Int) throws {
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).press(forDuration: 1.6)
        found(springboard.buttons["Edit"], "Edit").tap()
        found(springboard.buttons["Add Widget"], "Add Widget in the Edit menu").tap()
        let search = found(springboard.searchFields.firstMatch, "the widget search")
        search.tap()
        search.typeText("Orbital")
        found(springboard.cells.containing(.staticText, identifier: "Orbital").firstMatch, "Orbital among the widgets").tap()
        let preview = found(springboard.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Orbital,'")).firstMatch, "the widget's preview")
        for _ in 0..<page { preview.swipeLeft() }
        found(springboard.buttons.matching(NSPredicate(format: "label CONTAINS 'Add Widget'")).firstMatch, "the gallery's Add Widget").tap()
        if springboard.buttons["Done"].waitForExistence(timeout: 5) { springboard.buttons["Done"].tap() }
        // The app leaves what a widget shows in its Keychain group (Engine.keepGlimpse), which a build with signing off
        // (CODE_SIGNING_ALLOWED=NO, as CI builds) has none of: the widget is there and drawn, saying where to start
        if springboard.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Open Orbital to see'")).firstMatch.waitForExistence(timeout: 5),
           !springboard.buttons.containing(NSPredicate(format: "label CONTAINS 'Draft the Q4 hiring plan'")).firstMatch.exists {
            throw XCTSkip("the widget is added and drawn; what it shows needs a signed build (Keychain group), which CODE_SIGNING_ALLOWED=NO has not")
        }
    }

    func testTodaysTasksAndATapOpensTheTask() throws {
        try add(page: 1) // medium: a row a link of its own
        let task = found(springboard.buttons.containing(NSPredicate(format: "label CONTAINS 'Draft the Q4 hiring plan'")).firstMatch, "the widget's task")
        XCTAssertFalse(springboard.staticTexts["Send the offsite agenda"].exists, "a sensitive task's words are not on a widget")
        task.tap()
        XCTAssert(app.wait(for: .runningForeground, timeout: 15), "the task opens in the app")
    }

    func testTheTimelineOpensAMeetingsDocumentsInPlace() throws {
        try add(page: 3)
        // which meetings are open is kept by the extension, so one opened in an earlier run is open still: hidden first
        if springboard.buttons["Hide documents"].waitForExistence(timeout: 5) {
            springboard.buttons["Hide documents"].tap()
            XCTAssert(springboard.buttons["Show documents"].waitForExistence(timeout: 15), "its documents hidden again")
        }
        found(springboard.buttons["Show documents"], "a meeting's chevron").tap()
        let doc = found(springboard.buttons.containing(NSPredicate(format: "label CONTAINS 'Offsite planning'")).firstMatch, "the meeting's document")
        doc.tap()
        XCTAssert(app.wait(for: .runningForeground, timeout: 15))
        XCTAssert(app.staticTexts["Goals"].waitForExistence(timeout: 15), "the document, open in the app")
    }
}
