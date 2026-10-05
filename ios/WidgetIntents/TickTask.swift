import AppIntents
import Foundation

// A task's box on a widget (ios/Widgets), ticked by Orbital itself: a Button(intent:) of Orbital's own, so no link
// another app could send writes anything (Shell.swift open). Compiled into the app and the widgets (project.pbxproj,
// its WidgetIntents group). It opens the app; run there, the app's engine ticks the task at once (Writes.tick, Engine);
// run in the widget's own process, the tick is left in Orbital's own Keychain group, where no other app can write, and
// the app ticks it as it comes forward (Writes.take, Shell).
struct TickTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Tick Task on a Widget"
    static let isDiscoverable = false // the widgets' own: not offered in Shortcuts
    static let openAppWhenRun = true
    @Parameter(title: "Task") var id: String
    @Parameter(title: "State") var to: String // closed, or open: accepted from the Inbox, or ticked back on

    init() {}
    init(id: String, to: String) { self.id = id; self.to = to }

    @MainActor func perform() async throws -> some IntentResult {
        if let tick = Writes.tick { await tick(id, to) } else { Writes.leave(id, to) }
        return .result()
    }
}

// The writes a widget hands to the app
@MainActor enum Writes {
    static var tick: ((String, String) async -> Void)? // the app's engine (Engine.init); none in the widgets' process
    private static let account = "widget.ticks"
    private static let node = /tana:[a-z-]+:[0-9a-z]{26}/
    private static let states: Set<String> = ["open", "closed"]

    static func leave(_ id: String, _ to: String) {
        let list = waiting(Keychain.load(account, group: Keychain.group)) + [[id, to]]
        if let data = try? JSONEncoder().encode(list) { Keychain.save(data, account, group: Keychain.group) }
    }
    // in the app: the ticks left, each once, only a node's id and a box's state
    static func take() -> [(id: String, to: String)] {
        let list = waiting(Keychain.load(account))
        Keychain.delete(account)
        return list.compactMap { $0.count == 2 && $0[0].wholeMatch(of: node) != nil && states.contains($0[1]) ? ($0[0], $0[1]) : nil }
    }
    private static func waiting(_ data: Data?) -> [[String]] { data.flatMap { try? JSONDecoder().decode([[String]].self, from: $0) } ?? [] }
}
