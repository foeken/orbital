import XCTest

// ios/PhoneSpec.json, run on the iPhone: the rules both phones keep a copy of (ios/Common Ticks, Glimpse.activity and
// asTask, Phrases, Glyph), held to the cases Android runs too (android/shared/src/jvmTest SpecTest.kt). No app is
// launched: ios/Common is compiled into this bundle (project.pbxproj).
final class SpecTests: XCTestCase {
    private let spec: [String: Any] = {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("PhoneSpec.json")
        return (try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [String: Any] ?? [:]
    }()
    private func at(_ seconds: Any?) -> Date { Date(timeIntervalSince1970: (seconds as? Double) ?? 0) }
    private func string(_ v: Any?) -> String? { v as? String }
    private func row(_ json: Any) throws -> Glimpse.Row { try JSONDecoder().decode(Glimpse.Row.self, from: JSONSerialization.data(withJSONObject: json)) }

    func testTicks() throws {
        let cases = try XCTUnwrap(spec["ticks"] as? [[String: Any]], "ios/PhoneSpec.json is read")
        for c in cases {
            let name = string(c["name"]) ?? "?"
            var ticks = Ticks()
            for step in c["steps"] as? [[String: Any]] ?? [] {
                let gives = string(step["gives"])
                if let id = string(step["tap"]) { XCTAssertEqual(ticks.tap(id, shown: string(step["shown"])!, now: at(step["at"])), gives, name) }
                else if let id = string(step["set"]) { XCTAssertEqual(ticks.set(id, to: string(step["to"])!, now: at(step["at"])), gives, name) }
                else if let id = string(step["answer"]) { ticks.answer(id, string(step["state"])!) }
                else if let id = string(step["refuse"]) { ticks.refuse(id, back: string(step["back"])) }
                else if let read = step["settle"] as? [String: String] { ticks.settle(now: at(step["at"])) { read[$0] } }
                else if let want = step["ticks"] as? [String: Any] { for (id, state) in want { XCTAssertEqual(ticks.states[id], string(state), name + ": " + id) } }
                else if let id = string(step["state"]) { XCTAssertEqual(ticks.state(id, row: string(step["row"]), done: step["done"] as? Bool), gives, name) }
                else if let id = string(step["on"]) { XCTAssertEqual(ticks.on(id, uri: string(step["uri"])), gives, name) }
                else { XCTFail(name + ": a step this test does not know: \(step)") }
            }
        }
    }

    func testActivity() throws {
        let a = try XCTUnwrap(spec["activity"] as? [String: Any])
        let raw = try XCTUnwrap(a["rows"] as? [[String: Any]])
        let rows = try raw.map(row)
        let days = Glimpse(read: 0, rows: rows).activity(try XCTUnwrap(Date.tana(string(a["now"]) ?? "")))
        let said = { (title: String, lines: [(String, [String])]) in title + " = " + lines.map { $0.0 + " <" + $0.1.joined(separator: ",") + ">" }.joined(separator: " ") }
        let want = (a["days"] as? [[String: Any]] ?? []).map { d in said(string(d["title"]) ?? "", (d["lines"] as? [[String: Any]] ?? []).map { (string($0["id"]) ?? "", $0["added"] as? [String] ?? []) }) }
        XCTAssertEqual(days.map { d in said(d.title, d.lines.map { ($0.row.id, $0.added.map(\.id)) }) }, want)
        for t in a["tasks"] as? [[String: Any]] ?? [] {
            var json = try XCTUnwrap(raw.first { string($0["id"]) == string(t["line"]) })
            if let state = t["stateType"] { json["stateType"] = state } // a tick made since, kept on the line (Engine.keepTimeline)
            let line = try row(json), task = line.asTask()
            if let gives = t["gives"] as? [String: String] {
                XCTAssertEqual([task?.id, task?.title, task?.stateType], [gives["id"], gives["title"], gives["stateType"]], line.id)
            } else { XCTAssertNil(task, line.id) }
        }
    }

    func testPhrases() throws {
        let p = try XCTUnwrap(spec["phrases"] as? [String: Any])
        XCTAssertEqual(Phrases.states.map { [$0.0, $0.1] }, p["states"] as? [[String]])
        for (state, word) in p["state"] as? [String: String] ?? [:] { XCTAssertEqual(Phrases.state(state), word) }
        for c in p["audience"] as? [[String: Any]] ?? [] {
            let said = Phrases.audience(string(c["scope"])!, string(c["space"]))
            XCTAssertEqual([said.word, said.glyph], c["gives"] as? [String])
        }
        for (status, word) in p["agent"] as? [String: String] ?? [:] { XCTAssertEqual(Phrases.agent(status), word) }
        for c in p["free"] as? [[String: Any]] ?? [] {
            let said = Phrases.free(from: c["from"] as? Double ?? 0, until: c["until"] as? Double ?? 0, now: c["now"] as? Double ?? 0)
            XCTAssertEqual([said.0, said.1, said.2], c["gives"] as? [String])
        }
        for (kind, glyph) in p["glyphs"] as? [String: String] ?? [:] { XCTAssertEqual(Glyph.of(kind), glyph, kind) }
        for (icon, glyph) in p["markers"] as? [String: String] ?? [:] { XCTAssertEqual(Glyph.marker(icon), glyph, icon) }
    }
}
