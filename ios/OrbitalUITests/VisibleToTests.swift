import XCTest

// A zoomed note's Visible to (Pages.swift NodeDetails, Engine.Access.label) on the invented audiences of
// pages-sample.json: the glyph sits by its word, as Android's AudienceLabel draws it, at every text size, and VoiceOver
// reads the field's name and the word alone. A plain SwiftUI Label in a List row draws its glyph in the list's own icon
// column, some 20 pt from the word, which read as two things (issue #753).
final class VisibleToTests: XCTestCase {
    private var app: XCUIApplication!

    private static let audiences = [
        ("tana:text:00000000000000000000000d01", "Members of Offsite crew"), // a space, by its name
        ("tana:text:000000000000000000000000v3", "Space members"), // a space with no name to show
        ("tana:text:000000000000000000000000v1", "Only you"),
        ("tana:text:000000000000000000000000v2", "Selected people"), // a list with no one in it to draw as faces
        ("tana:text:000000000000000000000000v4", "Everyone"),
        ("tana:text:000000000000000000000000v5", "Unknown"),
    ]

    override func setUp() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    private func open(_ id: String, textSize: String? = nil) -> XCUIElement {
        app = XCUIApplication()
        app.launchArguments = ["-sample", "-demoMode", "NO", "-zoom", id] + (textSize.map { ["-UIPreferredContentSizeCategoryName", $0] } ?? [])
        app.launch()
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Visible to'")).firstMatch
        XCTAssert(row.waitForExistence(timeout: 15), "Visible to on " + id)
        return row
    }

    func testGlyphSitsByItsWord() {
        for size in [nil, "UICTContentSizeCategoryAccessibilityL"] {
            for (id, word) in Self.audiences {
                let row = open(id, textSize: size)
                XCTAssertEqual(row.label, "Visible to, " + word, "VoiceOver reads the word, not the glyph")
                let gap = Self.glyphGap(row)
                XCTAssertNotNil(gap, "a glyph and a word after the field's name: \(word), \(size ?? "default size")")
                // no wider than the field's own 12 pt between its name and its value, and not touching
                XCTAssert((3...12).contains(gap ?? 0), "\(word) at \(size ?? "default size"): the glyph is \(gap ?? 0) pt from its word")
                app.terminate()
            }
        }
    }

    // A list of people is its faces, read by their names (Faces), as before
    func testSelectedPeopleAreFaces() {
        XCTAssertEqual(open("tana:text:000000000000000000000000v6").label, "Visible to, Priya Shah, Sam Lee")
    }

    // The visibility sheet's Inherit names where it inherits from, in words only (no second glyph beside its own)
    func testSheetNamesWhatItInherits() {
        open("tana:text:00000000000000000000000d01").tap()
        XCTAssert(app.navigationBars["Visibility"].waitForExistence(timeout: 15))
        XCTAssert(app.buttons["Inherit, Members of Offsite crew"].exists, app.debugDescription)
    }

    // The gap in points between the glyph's last ink and the word's first, read from the row as drawn: the field's name
    // in its 100 pt column from the row's first ink, the glyph the first ink after it, 18 pt wide at most
    private static func glyphGap(_ row: XCUIElement) -> CGFloat? {
        guard let cg = row.screenshot().image.cgImage else { return nil }
        let w = cg.width, h = cg.height, scale = CGFloat(w) / row.frame.width
        var px = [UInt8](repeating: 0, count: w * h * 4)
        guard let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        let bg = (h / 2 * w + w - 2) * 4 // the row's far right, where nothing is drawn
        let ink = (0 ..< w).map { x in (0 ..< h).contains { y in (0 ..< 3).contains { abs(Int(px[(y * w + x) * 4 + $0]) - Int(px[bg + $0])) > 40 } } }
        var runs: [(from: CGFloat, to: CGFloat)] = [], start: Int?
        for x in 0 ... w {
            let on = x < w && ink[x]
            if on, start == nil { start = x } else if !on, let s = start { runs.append((CGFloat(s) / scale, CGFloat(x) / scale)); start = nil }
        }
        guard let first = runs.first, let glyph = runs.first(where: { $0.from >= first.from + 100 }) else { return nil }
        let glyphEnd = runs.filter { $0.from >= glyph.from && $0.from < glyph.from + 18 }.map(\.to).max()!
        return runs.first { $0.from >= glyphEnd }.map { $0.from - glyphEnd }
    }
}

