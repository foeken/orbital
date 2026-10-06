import Foundation

// The widgets' model, here rather than in ios/Widgets so the UI tests compile it too (SpecTests.swift runs
// ios/PhoneSpec.json's Activity lines against it, as Android's SpecTest runs them against Glimpse.kt).
// What the app keeps for the widgets (Engine.swift Glimpse, Glimpse.kt): only what is drawn here of each row
struct Glimpse: Decodable {
    let read: Double
    let rows: [Row]

    struct Row: Decodable {
        let id: String
        let text: String?
        let title: String?
        let segments: [Segment]?
        let icon: String?
        let stateType: String?
        let subtext: String?
        let start: String?
        let sensitive: Bool?
        let children: [Row]?
        let timeline: Info?

        struct Segment: Decodable { let text: String?; let mention: Mention?; let content: Bool?; let person: Bool? }
        struct Mention: Decodable { let label: String? }
        struct Free: Decodable { let until: Double }
        struct Info: Decodable {
            let uri: String?
            let tone: String?
            let today: Bool?
            let upcoming: Bool?
            let free: Free?
            let recording: Bool?
            let time: String?
            let day: String?
            let dayTitle: String?
        }

        var words: String {
            let said = (segments ?? []).map { $0.text ?? $0.mention?.label ?? "" }.joined()
            return said.isEmpty ? (title ?? text ?? "") : said
        }
        var top: Bool { timeline?.today == true || timeline?.upcoming == true || timeline?.free != nil }
    }

    // where the app leaves it: a Keychain item in Orbital's own access group (Widgets.entitlements, as Share.entitlements)
    static func read() -> Glimpse? { Keychain.load("glimpse", group: Keychain.group).flatMap { try? JSONDecoder().decode(Glimpse.self, from: $0) } }

    var today: [Row]? { rows.first { $0.timeline?.today == true }.map { $0.children ?? [] } }
    // drawn later than it was read: free time that has ended is gone, and a meeting that has started is no longer to come
    func free(_ now: Date) -> Date? {
        rows.compactMap(\.timeline?.free).first.map { Date(timeIntervalSince1970: $0.until / 1000) }.flatMap { $0 > now ? $0 : nil }
    }
    func upcoming(_ now: Date) -> [Row] {
        (rows.first { $0.timeline?.upcoming == true }?.children ?? []).filter { ($0.start.flatMap(Date.tana) ?? now) > now }
    }
    // what happened, under each day (Day.sections, as Timeline.swift draws them): Today and Yesterday against this phone's date
    func days(_ now: Date) -> [(title: String, rows: [Row])] {
        Day.sections(rows.filter { !$0.top }, now: now, key: { $0.timeline?.day }, title: { $0.timeline?.dayTitle })
    }
    // What happened, under each day, for the Activity widget, each task once: at the latest thing that happened to it
    // (the rows come newest first), so a task added and then completed is the completion alone. A line of tasks added
    // keeps the ones nothing happened to since, and goes when none is left; a day left empty goes too; a meeting is
    // always itself. With each line, the tasks it brought. Android's Glimpse.activity (GlimpseTest) is the same.
    func activity(_ now: Date) -> [(title: String, lines: [(row: Row, added: [Row])])] {
        var seen = Set<String>()
        return days(now).map { day in
            (day.title, day.rows.compactMap { e -> (row: Row, added: [Row])? in
                let added = e.children ?? []
                if Glyph.kind(of: e.timeline?.uri) == "event" { return (e, added) }
                if added.isEmpty { return e.timeline?.uri.map { seen.insert($0).inserted } == false ? nil : (e, added) }
                let fresh = added.filter { seen.insert($0.id).inserted }
                return fresh.isEmpty ? nil : (e, fresh)
            })
        }.filter { !$0.lines.isEmpty }
    }
}

// An Activity line about a task's state ("completed Plan the offsite"), drawn as the task itself: its box in the state
// the line left it in (the line's icon, main/timeline.js ICON) or a tick made since (Engine.keepTimeline keeps it on the
// line), and its title. Nil for any other line: an edit, a meeting.
// Android's Row.asTask (GlimpseTest) is the same.
extension Glimpse.Row {
    private static let stateOfIcon = ["apply": "closed", "tlAccepted": "open", "tlLater": "not_now", "tlInbox": "proposed"]
    func asTask() -> Glimpse.Row? {
        guard let uri = timeline?.uri, Glyph.kind(of: uri) == "text", let state = Self.stateOfIcon[icon ?? ""] else { return nil }
        return Glimpse.Row(id: uri, text: nil, title: segments?.last { $0.content == true }?.text ?? words, segments: nil, icon: nil, stateType: stateType ?? state,
                           subtext: nil, start: nil, sensitive: sensitive, children: nil, timeline: nil)
    }
}
