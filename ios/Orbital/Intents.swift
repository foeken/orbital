import AppIntents
import CoreSpotlight
import SwiftUI

// Siri, Shortcuts and Spotlight (issue #723): Orbital's tasks as an App Entity, and what can be done with one by voice or
// in a shortcut: add a task (pinned to today or not), check one off or uncheck it, pin or unpin it, open it, and hear
// today's. Tana is written by the engine, which runs in the app (Engine.swift), so whatever changes a task opens Orbital
// and runs there, writing through its engine as soon as Tana is connected; no link does it, so another app's orbital:
// links only open the place where you can (Shell.swift open).
// What is known without the app is what it last saved: for the widgets, today's tasks and the Timeline's
// (Engine.keepTimeline), and for Siri, the tasks assigned to you in every state (Engine.keepTasks); a sensitive one
// without its words, and the task types (orbital.taskTypes). List Tasks answers from those. On iOS 27 Siri also knows
// them as reminders (Schema.swift). The Android app has no counterpart yet (issue #723).

struct TaskEntity: AppEntity, IndexedEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Task"
    static let defaultQuery = TaskQuery()
    let id: String
    @Property(title: "Title") var title: String
    @Property(title: "Status") var status: TaskStatus
    @Property(title: "Type") var type: TaskTypeEntity?
    @Property(title: "Pinned to Today") var today: Bool
    let state: String // proposed, open, not_now or closed: Inbox, In Progress, Later or Completed
    var sensitive = false // marked sensitive: named only as one, never said or indexed (its words are not kept anyway)
    init(id: String, title: String, state: String, type: TaskTypeEntity? = nil, today: Bool = false, sensitive: Bool = false) {
        self.id = id; self.state = state; self.sensitive = sensitive
        self.title = title; self.status = .of(state); self.type = type; self.today = today
    }
    var done: Bool { state == "closed" }
    var spoken: String { sensitive ? "a sensitive task" : title }
    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: "\(type.map { $0.name + " · " } ?? "")\(TaskStatus.named(state))")
    }
}

// handed on as its words, to another app or a model (a sensitive one only as "Sensitive task")
extension TaskEntity: Transferable {
    static var transferRepresentation: some TransferRepresentation { ProxyRepresentation(exporting: \.title) }
}

// A Tana type with a workflow, which is what a task is (Bug, Action item), as Quick Add offers them (orbital.taskTypes)
struct TaskTypeEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Task Type"
    static let defaultQuery = TaskTypeQuery()
    let id: String
    @Property(title: "Name") var name: String
    init(id: String, name: String) { self.id = id; self.name = name }
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct TaskTypeQuery: EntityStringQuery {
    func entities(for identifiers: [TaskTypeEntity.ID]) async throws -> [TaskTypeEntity] { Tasks.types().filter { identifiers.contains($0.id) } }
    func entities(matching string: String) async throws -> [TaskTypeEntity] { Tasks.types().filter { $0.name.localizedStandardContains(string) } }
    func suggestedEntities() async throws -> [TaskTypeEntity] { Tasks.types() }
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
        Phrases.state(state)
    }
    static func of(_ state: String) -> TaskStatus {
        ["proposed": .inbox, "open": .inProgress, "not_now": .later, "closed": .completed][state] ?? .inProgress
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
// as one, and kept out of Spotlight. A task's type is known from yours (orbital.tasks typeUri) among the types saved.
enum Tasks {
    private struct Saved: Decodable { let rows: [Row] }
    private static func saved() -> [Row]? { Keychain.load("glimpse").flatMap { try? JSONDecoder().decode(Saved.self, from: $0).rows } }
    private static func yours() -> [Row]? { Keychain.load("tasks").flatMap { try? JSONDecoder().decode([Row].self, from: $0) } }
    private static func isTask(_ row: Row) -> Bool { row.id.hasPrefix("tana:text:") && row.stateType != nil }
    private static func todays(_ rows: [Row]) -> [Row] { rows.first { $0.timeline?.today == true }?.children ?? [] }
    // shortcut: a task of a type you cannot add to (another's space) has no type here, until orbital.tasks names its type
    static func types() -> [TaskTypeEntity] {
        (Keychain.load("taskTypes").flatMap { try? JSONDecoder().decode([Engine.TaskType].self, from: $0) } ?? [])
            .compactMap { t in t.uri.map { TaskTypeEntity(id: $0, name: t.title) } }
    }

    static func today() -> [TaskEntity]? {
        guard let rows = saved() else { return nil }
        let ids = Set(todays(rows).map(\.id))
        return known().filter { ids.contains($0.id) }
    }
    static func known() -> [TaskEntity] {
        let rows = saved() ?? [], mine = yours() ?? [], today = Set(todays(rows).map(\.id))
        let types = Dictionary(types().map { ($0.id, $0) }) { a, _ in a }
        let typeOf = Dictionary(mine.compactMap { r in r.typeUri.map { (r.id, $0) } }) { a, _ in a }
        func entity(_ row: Row) -> TaskEntity {
            TaskEntity(id: row.id, title: row.sensitive == true ? "Sensitive task" : row.words, state: row.stateType ?? "open",
                       type: typeOf[row.id].flatMap { types[$0] }, today: today.contains(row.id), sensitive: row.sensitive == true)
        }
        var seen = Set<String>(), out: [TaskEntity] = []
        func walk(_ rows: [Row]) { for row in rows { if isTask(row), seen.insert(row.id).inserted { out.append(entity(row)) }; walk(row.children ?? []) } }
        walk(rows.filter { $0.timeline?.today == true })
        walk(rows)
        walk(mine)
        return out
    }
    // nil before the app has saved any
    static func listed(_ status: TaskStatus, type: TaskTypeEntity? = nil) -> [TaskEntity]? {
        guard saved() != nil || yours() != nil else { return nil }
        return known().filter { status.includes($0.state) && (type == nil || $0.type?.id == type?.id) }
    }

    // Spotlight finds what the widgets show, once it changes; nothing sensitive, and nothing at all in Demo mode or once
    // signed out (Engine.keepTimeline, Engine.forgetTimeline). On iOS 27 as reminders, which Siri searches by meaning
    // (Schema.swift), else as tasks: one or the other, so nothing is found twice.
    private static var indexed: [String] = []
    static func index(demo: Bool) async {
        let shown = demo ? [] : known().filter { !$0.sensitive }, types = demo ? [] : types()
        let key = shown.map { $0.id + $0.state + $0.title + ($0.type?.id ?? "") + ($0.today ? "today" : "") } + types.map { $0.id + $0.name }
        guard key != indexed else { return }
        indexed = key
        let index = CSSearchableIndex.default()
        try? await index.deleteAppEntities(ofType: TaskEntity.self)
        #if compiler(>=6.4)
        if #available(iOS 27, *) {
            try? await index.deleteAppEntities(ofType: TaskReminder.self)
            try? await index.deleteAppEntities(ofType: TaskList.self) // Tana's types come and go: the lists as they are now
            if !shown.isEmpty { try? await index.indexAppEntities(shown.map(TaskReminder.init)) }
            if !types.isEmpty { try? await index.indexAppEntities([TaskList.plain] + types.map { TaskList($0) }) }
            return
        }
        #endif
        if !shown.isEmpty { try? await index.indexAppEntities(shown) }
    }
}

// The task a view shows, for the new Siri: "check this off" knows which (Timeline.swift TaskBox, a task's own page in
// Pages.swift); on iOS 27 as the reminder Siri acts on (Schema.swift). Built with Xcode 26, as CI builds, none is carried.
extension View {
    @ViewBuilder func taskEntity(_ id: String?) -> some View {
        #if compiler(>=6.4)
        if #available(iOS 27, *) {
            appEntityIdentifier(id.map { EntityIdentifier(for: TaskReminder.self, identifier: $0) })
        } else {
            appEntityIdentifier(id.map { EntityIdentifier(for: TaskEntity.self, identifier: $0) })
        }
        #else
        self
        #endif
    }
}
private func opening(_ link: String) -> some IntentResult & OpensIntent { .result(opensIntent: OpenURLIntent(URL(string: link)!)) }

// The app's engine, for an intent that runs in the app (openAppWhenRun): waited for while the launch the intent opened
// makes it (ContentView)
@MainActor func engine() async throws -> Engine {
    for _ in 0..<150 {
        if let engine = Engine.current { return engine }
        try await Task.sleep(for: .milliseconds(100))
    }
    throw Engine.Failure(errorDescription: "Orbital did not start in time")
}

struct AddTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Add Task"
    static let description = IntentDescription("Adds a task to Orbital, of a type and pinned to today if you like.")
    static let openAppWhenRun = true
    @Parameter(title: "Task", requestValueDialog: "What's the task?") var name: String
    @Parameter(title: "Type") var type: TaskTypeEntity?
    @Parameter(title: "Pin to Today", default: false) var today: Bool
    static var parameterSummary: some ParameterSummary { Summary("Add \(\.$name)") { \.$type; \.$today } }

    // made as Quick Add makes it (Engine.add): one Tana did not take is in the next Quick Add, as it was asked for
    @MainActor func perform() async throws -> some IntentResult {
        let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { throw Engine.Failure(errorDescription: "A task needs a title") }
        try await engine().add(.init(title: title, type: type?.id, search: nil, assignee: nil, values: [:], today: today))
        return .result()
    }
}

struct CheckTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Check Off Task"
    static let description = IntentDescription("Ticks a task off in Orbital.")
    static let openAppWhenRun = true
    @Parameter(title: "Task") var task: TaskEntity
    static var parameterSummary: some ParameterSummary { Summary("Check off \(\.$task)") }
    @MainActor func perform() async throws -> some IntentResult { try await engine().tick(task.id, to: "closed"); return .result() }
}

struct UncheckTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Uncheck Task"
    static let description = IntentDescription("Ticks a done task back on in Orbital.")
    static let openAppWhenRun = true
    @Parameter(title: "Task") var task: TaskEntity
    static var parameterSummary: some ParameterSummary { Summary("Uncheck \(\.$task)") }
    @MainActor func perform() async throws -> some IntentResult { try await engine().tick(task.id, to: "open"); return .result() }
}

struct PinTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Pin Task to Today"
    static let description = IntentDescription("Pins a task to today in Orbital, or takes its pin off.")
    static let openAppWhenRun = true
    @Parameter(title: "Task") var task: TaskEntity
    @Parameter(title: "Pinned", default: true) var on: Bool
    static var parameterSummary: some ParameterSummary {
        When(\.$on, .equalTo, true) { Summary("Pin \(\.$task) to today") { \.$on } } otherwise: { Summary("Unpin \(\.$task)") { \.$on } }
    }
    @MainActor func perform() async throws -> some IntentResult { try await engine().pin(task.id, on); return .result() }
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
            : "\(open.count) to do today: " + open.map(\.spoken).formatted(.list(type: .and)) + "."
        return .result(value: tasks, dialog: "\(said)")
    }
}

// Your tasks, filtered by status (all but the completed ones unless you ask), said and handed on without opening the
// app: as it last read them
struct ListTasksIntent: AppIntent {
    static let title: LocalizedStringResource = "List Tasks"
    static let description = IntentDescription("Lists your tasks by status and type, as Orbital last read them: all but the completed ones, unless you choose.")
    static let supportedModes: IntentModes = .background
    @Parameter(title: "Status", default: .notDone) var status: TaskStatus
    @Parameter(title: "Type") var type: TaskTypeEntity?
    static var parameterSummary: some ParameterSummary { Summary("List \(\.$status) tasks") { \.$type } }

    func perform() async throws -> some IntentResult & ReturnsValue<[TaskEntity]> & ProvidesDialog {
        guard let tasks = Tasks.listed(status, type: type) else { return .result(value: [], dialog: "Open Orbital once, so it can read your tasks.") }
        let names = tasks.map(\.spoken)
        let said = tasks.isEmpty ? "No tasks there."
            : "\(tasks.count) \(tasks.count == 1 ? "task" : "tasks"): " + (names.count > 8 ? Array(names.prefix(8)) + ["\(names.count - 8) more"] : names).formatted(.list(type: .and)) + "."
        return .result(value: tasks, dialog: "\(said)")
    }
}

// what Siri knows to say, with no shortcut set up first
struct OrbitalShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: AddTaskIntent(), phrases: ["Add a task in \(.applicationName)", "Add an \(.applicationName) task", "Add a \(\.$type) in \(.applicationName)"],
                    shortTitle: "Add Task", systemImageName: "plus.circle")
        AppShortcut(intent: TodaysTasksIntent(), phrases: ["What's on today in \(.applicationName)", "Today's tasks in \(.applicationName)"],
                    shortTitle: "Today's Tasks", systemImageName: "checklist")
        AppShortcut(intent: ListTasksIntent(), phrases: ["List my tasks in \(.applicationName)", "List my \(\.$status) tasks in \(.applicationName)", "List my \(\.$type) tasks in \(.applicationName)"],
                    shortTitle: "List Tasks", systemImageName: "list.bullet")
        AppShortcut(intent: CheckTaskIntent(), phrases: ["Check off \(\.$task) in \(.applicationName)", "Check off a task in \(.applicationName)"],
                    shortTitle: "Check Off Task", systemImageName: "checkmark.circle")
        AppShortcut(intent: OpenTaskIntent(), phrases: ["Open \(\.$target) in \(.applicationName)"], shortTitle: "Open Task", systemImageName: "arrow.up.forward.app")
    }
}
