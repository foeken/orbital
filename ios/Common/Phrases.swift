import Foundation

// The app's own words for what Tana says, in one place: a task's state, who can see a document, how far your agent is,
// the free time before the next meeting. Android's Phrases.kt is the same, names and all, and both phones hold theirs to
// ios/PhoneSpec.json (SpecTests.swift here, SpecTest.kt there).
enum Phrases {
    // Tana's four states, as the desktop's Status pill names them (renderer/pills.js)
    static let states = [("proposed", "Inbox"), ("open", "In Progress"), ("closed", "Completed"), ("not_now", "Later")]
    static func state(_ state: String?) -> String { states.first { $0.0 == state }?.1 ?? "In Progress" }

    // renderer/tasks.js AUDIENCES: who can see a document, its word and its glyph, a space by its name
    static func audience(_ scope: String, _ space: String?) -> (word: String, glyph: String) {
        switch scope {
        case "only-me": ("Only you", "lock")
        case "people": ("Selected people", "userLock")
        case "space": (space.map { "Members of " + $0 } ?? "Space members", "houseLock")
        case "everyone": ("Everyone", "users")
        default: ("Unknown", "hidden")
        }
    }

    // a node's last Agent status line, as the Mac's badge reads it: Assigned is waiting for the agent to pick it up
    static func agent(_ status: String) -> String { ["assigned": "Assigned", "working": "Working", "completed": "Completed", "failed": "Failed"][status] ?? "Assigned" }

    // The free time before the next meeting, counted down while it shows (renderer/timeline.js timelineFreeSegs):
    // "No meetings for ", the time in bold, and " after this one" while a meeting is still on; times in ms
    static func free(from: Double, until: Double, now: Double) -> (String, String, String) {
        let later = from > now
        let m = max(1, Int(((until - max(now, from)) / 60000).rounded(.up)))
        let left = m < 60 ? "\(m) \(later ? "" : "more ")min" : "\(m / 60) h" + (m % 60 > 0 ? " \(m % 60) min" : "")
        return ("No meetings for ", left, later ? " after this one" : "")
    }

    // A node's pinned days (YYYY-MM-DD, orbital.setup days): its pin menu lists today, tomorrow and every later day it is
    // pinned to, each with whether it is; the line under its title names those from today on. Days gone by stay pinned
    // until Remove All Pins and are not listed: a task pinned day after day would fill the menu.
    static func pinChoices(_ days: [String], today: String, tomorrow: String) -> [(day: String, on: Bool)] {
        ([today, tomorrow] + Set(days.filter { $0 > tomorrow }).sorted()).map { ($0, days.contains($0)) }
    }
    // The days a node's page counts it pinned to: an open task pinned to a day gone by stays in Today's Tasks
    // (main/timeline.js), and the Mac's drag onto Today's Tasks pins no new day for it (renderer/drag.js), so on Today's
    // Tasks such a pin is today's too
    static func pinDays(_ days: [String], today: String, onToday: Bool) -> [String] {
        onToday && !days.contains(today) && days.contains { $0 < today } ? (days + [today]).sorted() : days
    }
    static func pinnedTo(_ days: [String], today: String, tomorrow: String) -> String? {
        let words = Set(days.filter { $0 >= today }).sorted().map { $0 == today ? "today" : $0 == tomorrow ? "tomorrow" : day($0) }
        guard let last = words.last else { return nil }
        return "Pinned to " + (words.count == 1 ? last : words.dropLast().joined(separator: ", ") + " and " + last)
    }
    static func pinDay(_ key: String, today: String, tomorrow: String) -> String { key == today ? "Today" : key == tomorrow ? "Tomorrow" : day(key) }
    // YYYY-MM-DD as "Fri 23 Oct", in the app's English whatever the phone's language
    static func day(_ key: String) -> String {
        let p = key.split(separator: "-").compactMap { Int($0) }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        guard p.count == 3, (1...12).contains(p[1]), let d = cal.date(from: DateComponents(year: p[0], month: p[1], day: p[2])) else { return key }
        let weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][cal.component(.weekday, from: d) - 1]
        return "\(weekday) \(p[2]) " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][p[1] - 1]
    }
}
