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
}
