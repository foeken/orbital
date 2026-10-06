import Foundation

// A task's box ticked on this phone: drawn in its new state at once, before engine.js has written it, since a tap must
// answer without a round trip through the page (Engine.toggle, tick). The state ticked stands until a read of Tana
// agrees with it, or still disagrees half a minute on (Tana refused it later than the engine waits for, or someone changed
// it back): the graph can trail a write by seconds, never by that long. One that is not in the rows read keeps its tick.
// Android's Ticks.kt is the same, names and all, and both phones run the cases in ios/PhoneSpec.json (SpecTests.swift
// here, SpecTest.kt there): one rule, written twice, held to one spec.
struct Ticks {
    private(set) var states: [String: String] = [:] // task id -> the state ticked here
    private var at: [String: Date] = [:] // task id -> when
    static let patience: TimeInterval = 30

    // what a task's box shows: a tick made here, else what Tana said, else its done
    func state(_ id: String, row: String?, done: Bool? = nil) -> String { states[id] ?? row ?? (done == true ? "closed" : "open") }
    // a tick made here on the task, or on the task a Timeline line is about (its uri), which a widget draws as the task
    func on(_ id: String, uri: String? = nil) -> String? { states[id] ?? uri.flatMap { states[$0] } }

    // a box tapped, showing shown: its next state by the desktop's rule (next), drawn at once
    @discardableResult mutating func tap(_ id: String, shown: String, now: Date = .now) -> String {
        let next = Self.next(shown)
        set(id, to: next, now: now)
        return next
    }
    // a state set outright (a widget's box, Move to Inbox, a Status picked); answers the tick it replaced, to put back
    @discardableResult mutating func set(_ id: String, to: String, now: Date = .now) -> String? {
        let before = states[id]
        states[id] = to; at[id] = now
        return before
    }
    // engine.js answered with the state it wrote
    mutating func answer(_ id: String, _ state: String) { states[id] = state }
    // Tana refused: back to what it was (nil: no tick of ours)
    mutating func refuse(_ id: String, back: String?) { states[id] = back }

    // a read of Tana: read answers a task's state there, nil for one it does not show
    mutating func settle(now: Date = .now, _ read: (String) -> String?) {
        let at = at
        states = states.filter { id, state in
            guard let was = read(id) else { return true }
            return was != state && now.timeIntervalSince(at[id] ?? .distantPast) < Self.patience
        }
        self.at = at.filter { states[$0.key] != nil }
    }

    // renderer/edit.js toggleDone: an Inbox task is accepted (In Progress) before a second tap completes it, a completed
    // one is opened again, anything else is completed
    static func next(_ shown: String) -> String { shown == "proposed" || shown == "closed" ? "open" : "closed" }
}
