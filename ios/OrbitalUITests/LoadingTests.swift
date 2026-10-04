import XCTest

// Tana that never answers (-stall, Engine.swift): a request inside Tana's page has no time limit of WebKit's, so a page
// that never connects, or a first Timeline read that never comes back, left the Timeline building itself for good, with
// the Ask Tana composer under it and nothing to say why (a TestFlight report). Past the app's patience (-patience 3 here,
// 30 s in the app) it says so instead, with Try again and the Details to send.
final class LoadingTests: XCTestCase {
    private var app: XCUIApplication!

    private func launch(stalling stage: String) {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        app = XCUIApplication()
        app.launchArguments = ["-stall", stage, "-patience", "3", "-demoMode", "NO"]
        app.launch()
    }

    // what the app says once it gives up waiting, and the log line that names the step it waited on
    private func saysItCannotReachTana(_ step: String) {
        XCTAssert(app.staticTexts["Can't reach Tana"].waitForExistence(timeout: 20), "the app says so, rather than building for ever:\n" + app.debugDescription)
        XCTAssert(app.buttons["Try again"].exists)
        app.buttons["Details"].tap()
        XCTAssert(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", step)).firstMatch.waitForExistence(timeout: 10), "Details names the step: " + step)
    }

    func testAPageThatNeverConnectsSaysSo() {
        launch(stalling: "page")
        saysItCannotReachTana("did not connect")
    }

    func testAFirstReadThatNeverAnswersSaysSo() {
        launch(stalling: "read")
        saysItCannotReachTana("did not send the Timeline")
    }

    // Try again starts the page over: the Timeline builds itself again, and says so again when it is still not there
    func testTryAgainWaitsAgain() {
        launch(stalling: "page")
        XCTAssert(app.buttons["Try again"].waitForExistence(timeout: 20))
        app.buttons["Try again"].tap()
        XCTAssert(app.otherElements["Loading"].waitForExistence(timeout: 5), "building again")
        XCTAssert(app.staticTexts["Can't reach Tana"].waitForExistence(timeout: 20))
    }
}
