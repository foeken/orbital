import AppIntents
import CoreSpotlight

// Siri, Shortcuts and Spotlight (issue #723): Orbital's tasks as an App Entity, and what can be done with one by voice or
// in a shortcut: add a task (pinned to today or not), check one off or uncheck it, pin or unpin it, open it, and hear
// today's. Tana is written by the engine, which runs in the app (Engine.swift), so whatever changes a task opens Orbital
// with the orbital: links the widgets use (Shell.swift onOpenURL) and the app writes it as soon as Tana is connected.
// What is known without the app is what it last saved: for the widgets, today's tasks and the Timeline's
// (Engine.keepGlimpse), and for Siri, the tasks assigned to you in every state (Engine.keepTasks); a sensitive one
// without its words. List Tasks answers from those. The Android app has no counterpart yet (issue #723).

struct TaskEntity: AppEntity, IndexedEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Task"
    static let defaultQuery = TaskQuery()
    let id: String
    let title: String
    let state: String // proposed, open, not_now or closed: Inbox, In Progress, Later or Completed
    var done: Bool { state == "closed" }
    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: "\(TaskStatus.named(state))")
    }
}

// What List Tasks shows: everything but what is completed unless you ask, or one state of Tana's
enum TaskStatus: String, AppEnum {
    case notDone, inbox, inProgress, later, completed, all
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Status"
    static let caseDisplayRepresentations: [TaskStatus: DisplayRepresentation] = [
        .notDone: DisplayRepresentation(title: "Not completed", synonyms: ["open", "to do", "unfinished"]),
        .inbox: "Inbox", .inProgress: DisplayRepresentation(title: "In Progress", synonyms: ["accepted"]),
        .later: "Later", .completed: DisplayRepresentation(title: "Completed", synonyms: ["done", "finished"]), .all: "All",
    ]
    func includes(_ state: String) -> Bool {
        switch self {
        case .notDone: state != "closed"
        case .inbox: state == "proposed"
        case .inProgress: state == "open"
        case .later: state == "not_now"
        case .completed: state == "closed"
        case .all: true
        }
    }
    static func named(_ state: String) -> String {
        switch state { case "proposed": "Inbox"; case "not_now": "Later"; case "closed": "Completed"; default: "In Progress" }
    }
}

// Siri and Shortcuts find a task among those the app last saved, by the words you say
struct TaskQuery: EntityStringQuery {
    func entities(for identifiers: [TaskEntity.ID]) async throws -> [TaskEntity] {
        let known = Tasks.known()
        return identifiers.compactMap { id in known.first { $0.id == id } }
    }
    func entities(matching string: String) async throws -> [TaskEntity] { Tasks.known().filter { $0.title.localizedStandardContains(string) } }
    func suggestedEntities() async throws -> [TaskEntity] { Tasks.known() }
}

// The tasks the app last saved: today's first, then the rest of the Timeline's, then the rest of yours, each once (the
// widgets' copy is the fresher, so it is read first). A sensitive task is there without its words, so it is named only
// as one, and kept out of Spotlight.
enum Tasks {
    private struct Saved: Decodable { let rows: [Row] }
    private static func saved() -> [Row]? { Keychain.load("glimpse").flatMap { try? JSONDecoder().decode(Saved.self, from: $0).rows } }
    private static func yours() -> [Row]? { Keychain.load("tasks").flatMap { try? JSONDecoder().decode([Row].self, from: $0) } }
    private static func entity(_ row: Row) -> TaskEntity {
        TaskEntity(id: row.id, title: row.sensitive == true ? "Sensitive task" : row.words, state: row.stateType ?? "open")
    }
    private static func isTask(_ row: Row) -> Bool { row.id.hasPrefix("tana:text:") && row.stateType != nil }

    static func today() -> [TaskEntity]? {
        guard let rows = saved() else { return nil }
        return (rows.first { $0.timeline?.today == true }?.children ?? []).filter(isTask).map(entity)
    }
    static func known() -> [TaskEntity] {
        var seen = Set<String>(), out: [TaskEntity] = []
        func walk(_ rows: [Row]) { for row in rows { if isTask(row), seen.insert(row.id).inserted { out.append(entity(row)) }; walk(row.children ?? []) } }
        let rows = saved() ?? []
        walk(rows.filter { $0.timeline?.today == true })
        walk(rows)
        walk(yours() ?? [])
        return out
    }
    // nil before the app has saved any
    static func listed(_ status: TaskStatus) -> [TaskEntity]? {
        guard saved() != nil || yours() != nil else { return nil }
        return known().filter { status.includes($0.state) }
    }

    // Spotlight finds what the widgets show, once it changes; nothing sensitive, and nothing at all in Demo mode or once
    // signed out (Engine.keepGlimpse, Engine.signOut)
    private static var indexed: [String] = []
    static func index(demo: Bool) async {
        let shown = demo ? [] : known().filter { $0.title != "Sensitive task" }
        let key = shown.map { $0.id + $0.state + $0.title }
        guard key != indexed else { return }
        indexed = key
        try? await CSSearchableIndex.default().deleteAppEntities(ofType: TaskEntity.self)
        if !shown.isEmpty { try? await CSSearchableIndex.default().indexAppEntities(shown) }
    }
}

// what changes a task opens Orbital, which does it at once (Shell.swift)
private func opening(_ link: String) -> some IntentResult & OpensIntent { .result(opensIntent: OpenURLIntent(URL(string: link)!)) }

struct AddTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Add Task"
    static let description = IntentDescription("Adds a task to Orbital, pinned to today if you like.")
    @Parameter(title: "Task", requestValueDialog: "What's the task?") var name: String
    @Parameter(title: "Pin to Today", default: false) var today: Bool
    static var parameterSummary: some ParameterSummary { Summary("Add \(\.$name)") { \.$today } }

    func perform() async throws -> some IntentResult & OpensIntent {
        var link = URLComponents()
        link.scheme = "orbital"
        link.path = "new"
        link.queryItems = [URLQueryItem(name: "title", value: name)] + (today ? [URLQueryItem(name: "today", value: "1")] : [])
        return .result(opensIntent: OpenURLIntent(link.url!))
    }
}

struct CheckTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Check Off Task"
    static let description = IntentDescription("Ticks a task off in Orbital.")
    @Parameter(title: "Task") var task: TaskEntity
    static var parameterSummary: some ParameterSummary { Summary("Check off \(\.$task)") }
    func perform() async throws -> some IntentResult & OpensIntent { opening("orbital:check:" + task.id) }
}

struct UncheckTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Uncheck Task"
    static let description = IntentDescription("Ticks a done task back on in Orbital.")
    @Parameter(title: "Task") var task: TaskEntity
    static var parameterSummary: some ParameterSummary { Summary("Uncheck \(\.$task)") }
    func perform() async throws -> some IntentResult & OpensIntent { opening("orbital:uncheck:" + task.id) }
}

struct PinTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Pin Task to Today"
    static let description = IntentDescription("Pins a task to today in Orbital, or takes its pin off.")
    @Parameter(title: "Task") var task: TaskEntity
    @Parameter(title: "Pinned", default: true) var on: Bool
    static var parameterSummary: some ParameterSummary {
        When(\.$on, .equalTo, true) { Summary("Pin \(\.$task) to today") { \.$on } } otherwise: { Summary("Unpin \(\.$task)") { \.$on } }
    }
    func perform() async throws -> some IntentResult & OpensIntent { opening((on ? "orbital:pin:" : "orbital:unpin:") + task.id) }
}

// a task opened in Orbital; Spotlight's results open through it too
struct OpenTaskIntent: OpenIntent {
    static let title: LocalizedStringResource = "Open Task"
    @Parameter(title: "Task") var target: TaskEntity
    func perform() async throws -> some IntentResult & OpensIntent { opening("orbital:" + target.id) }
}

// Today's tasks, said and handed on, without opening the app: as it last read them
struct TodaysTasksIntent: AppIntent {
    static let title: LocalizedStringResource = "Today's Tasks"
    static let description = IntentDescription("Lists the tasks pinned to today, as Orbital last read them.")
    static let supportedModes: IntentModes = .background

    func perform() async throws -> some IntentResult & ReturnsValue<[TaskEntity]> & ProvidesDialog {
        guard let tasks = Tasks.today() else { return .result(value: [], dialog: "Open Orbital once, so it can read your tasks.") }
        let open = tasks.filter { !$0.done }
        let said = tasks.isEmpty ? "Nothing is pinned to today."
            : open.isEmpty ? "Everything pinned to today is done."
            : "\(open.count) to do today: " + open.map { $0.title == "Sensitive task" ? "a sensitive task" : $0.title }.formatted(.list(type: .and)) + "."
        return .result(value: tasks, dialog: "\(said)")
    }
}

// Your tasks, filtered by status (all but the completed ones unless you ask), said and handed on without opening the
// app: as it last read them
struct ListTasksIntent: AppIntent {
    static let title: LocalizedStringResource = "List Tasks"
    static let description = IntentDescription("Lists your tasks by status, as Orbital last read them: all but the completed ones, unless you choose.")
    static let supportedModes: IntentModes = .background
    @Parameter(title: "Status", default: .notDone) var status: TaskStatus
    static var parameterSummary: some ParameterSummary { Summary("List \(\.$status) tasks") }

    func perform() async throws -> some IntentResult & ReturnsValue<[TaskEntity]> & ProvidesDialog {
        guard let tasks = Tasks.listed(status) else { return .result(value: [], dialog: "Open Orbital once, so it can read your tasks.") }
        let names = tasks.map { $0.title == "Sensitive task" ? "a sensitive task" : $0.title }
        let said = tasks.isEmpty ? "No tasks there."
            : "\(tasks.count) \(tasks.count == 1 ? "task" : "tasks"): " + (names.count > 8 ? Array(names.prefix(8)) + ["\(names.count - 8) more"] : names).formatted(.list(type: .and)) + "."
        return .result(value: tasks, dialog: "\(said)")
    }
}

// what Siri knows to say, with no shortcut set up first
struct OrbitalShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: AddTaskIntent(), phrases: ["Add a task in \(.applicationName)", "Add an \(.applicationName) task"],
                    shortTitle: "Add Task", systemImageName: "plus.circle")
        AppShortcut(intent: TodaysTasksIntent(), phrases: ["What's on today in \(.applicationName)", "Today's tasks in \(.applicationName)"],
                    shortTitle: "Today's Tasks", systemImageName: "checklist")
        AppShortcut(intent: ListTasksIntent(), phrases: ["List my tasks in \(.applicationName)", "List my \(\.$status) tasks in \(.applicationName)"],
                    shortTitle: "List Tasks", systemImageName: "list.bullet")
        AppShortcut(intent: CheckTaskIntent(), phrases: ["Check off \(\.$task) in \(.applicationName)", "Check off a task in \(.applicationName)"],
                    shortTitle: "Check Off Task", systemImageName: "checkmark.circle")
        AppShortcut(intent: OpenTaskIntent(), phrases: ["Open \(\.$target) in \(.applicationName)"], shortTitle: "Open Task", systemImageName: "arrow.up.forward.app")
    }
}
