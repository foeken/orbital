#if compiler(>=6.4)
import AppIntents
import Foundation
import GeoToolbox

// iOS 27's Siri with App Schemas: Orbital's tasks as the reminders Siri already knows how to add, tick off, pin to a
// day and delete, with no phrases to learn, each Tana task type a list of them (Tasks for a task of no type). They are
// the tasks of Intents.swift (Tasks.known), whose TaskEntity iOS 26 and Shortcuts keep using: a schema's type cannot
// exist before iOS 27. What a Tana task has is said; what it has not (a note, tags, links, a flag, a repeat, a place,
// a day other than today) is refused in words, never dropped. Each one opens Orbital and runs through its engine.

@available(iOS 27, *)
@AppEnum(schema: .reminders.listType)
enum TaskListKind: String {
    case standard
    static let caseDisplayRepresentations: [TaskListKind: DisplayRepresentation] = [.standard: "Task type"]
}

// A Tana task type as a list of reminders, and the tasks of no type as Tasks. Tana's types are made and renamed at any
// time, so they are entities, found when Siri asks (TaskListQuery, over what Engine.keepTasks last saved) and in
// Spotlight's index (Tasks.index), never cases fixed when the app is built.
@available(iOS 27, *)
@AppEntity(schema: .reminders.list)
struct TaskList: IndexedEntity {
    static let defaultQuery = TaskListQuery()
    static let plain = TaskList(id: "tasks", name: "Tasks")
    let id: String
    var name: String
    var type: TaskListKind
    init(id: String, name: String) { self.id = id; self.name = name; self.type = .standard }
    init(_ type: TaskTypeEntity?) { self.init(id: type?.id ?? Self.plain.id, name: type?.name ?? Self.plain.name) }
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
    var taskType: String? { id == Self.plain.id ? nil : id }
}

@available(iOS 27, *)
struct TaskListQuery: EntityStringQuery {
    static func all() -> [TaskList] { [.plain] + Tasks.types().map { TaskList($0) } }
    func entities(for identifiers: [TaskList.ID]) async throws -> [TaskList] { Self.all().filter { identifiers.contains($0.id) } }
    func entities(matching string: String) async throws -> [TaskList] { Self.all().filter { $0.name.localizedStandardContains(string) } }
    func suggestedEntities() async throws -> [TaskList] { Self.all() }
}

// Sections and places the schema asks for, which Orbital's tasks have none of: none is ever found
@available(iOS 27, *)
@AppEntity(schema: .reminders.section)
struct TaskSection {
    static let defaultQuery = TaskSectionQuery()
    let id: String
    var name: String
    var list: TaskList
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

@available(iOS 27, *)
@AppEnum(schema: .reminders.locationTriggerEvent)
enum TaskPlaceEvent: String {
    case arrive, depart
    static let caseDisplayRepresentations: [TaskPlaceEvent: DisplayRepresentation] = [.arrive: "Arrive", .depart: "Depart"]
}

@available(iOS 27, *)
@AppEntity(schema: .reminders.locationTrigger)
struct TaskPlace {
    static let defaultQuery = TaskPlaceQuery()
    let id: String
    var place: PlaceDescriptor
    var event: TaskPlaceEvent
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(event.rawValue)") }
}

@available(iOS 27, *)
struct TaskSectionQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [TaskSection] { [] }
    func entities(matching string: String) async throws -> [TaskSection] { [] }
}

@available(iOS 27, *)
struct TaskPlaceQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [TaskPlace] { [] }
    func entities(matching string: String) async throws -> [TaskPlace] { [] }
}

// A task as a reminder: pinned to today is due today, done is completed, and nothing else a reminder can have. Its id
// is Tana's, the same on every device.
@available(iOS 27, *)
@AppEntity(schema: .reminders.reminder)
struct TaskReminder: IndexedEntity, SyncableEntity {
    static let defaultQuery = TaskReminderQuery()
    let id: String
    var title: String
    var note: AttributedString?
    var tags: Set<String>
    var urls: [URL]
    var dueDate: DateComponents?
    var recurrence: Calendar.RecurrenceRule?
    var isCompleted: Bool
    var isFlagged: Bool?
    var creationDate: Date?
    var completionDate: Date?
    var list: TaskList
    var locationTrigger: TaskPlace?
    init(id: String, title: String, isCompleted: Bool, today: Bool, list: TaskList) {
        self.id = id; self.title = title; self.isCompleted = isCompleted; self.dueDate = today ? DueDay.today : nil; self.list = list
        self.note = nil; self.tags = []; self.urls = []; self.recurrence = nil; self.isFlagged = nil
        self.creationDate = nil; self.completionDate = nil; self.locationTrigger = nil
    }
    init(_ task: TaskEntity) { self.init(id: task.id, title: task.title, isCompleted: task.done, today: task.today, list: TaskList(task.type)) }
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)", subtitle: "\(list.name)") }
}

@available(iOS 27, *)
struct TaskReminderQuery: EntityStringQuery {
    func entities(for identifiers: [TaskReminder.ID]) async throws -> [TaskReminder] { Tasks.known().filter { identifiers.contains($0.id) }.map(TaskReminder.init) }
    func entities(matching string: String) async throws -> [TaskReminder] { Tasks.known().filter { $0.title.localizedStandardContains(string) }.map(TaskReminder.init) }
    func suggestedEntities() async throws -> [TaskReminder] { Tasks.known().map(TaskReminder.init) }
}

// Tana pins a task to a day, and Orbital to today only; and what else a reminder can be given, a task cannot have
@available(iOS 27, *)
enum DueDay {
    static var today: DateComponents { Calendar.current.dateComponents([.year, .month, .day], from: .now) }
    static func pins(_ due: DateComponents?) throws -> Bool {
        guard let due else { return false }
        guard let day = Calendar.current.date(from: due), Calendar.current.isDateInToday(day) else {
            throw Engine.Failure(errorDescription: "Orbital pins a task to today only")
        }
        return true
    }
    static func refuse(_ asked: KeyValuePairs<String, Bool>) throws {
        let names = asked.filter(\.value).map(\.key)
        if !names.isEmpty { throw Engine.Failure(errorDescription: "Orbital tasks have no " + names.formatted(.list(type: .or))) }
    }
}

@available(iOS 27, *)
@AppIntent(schema: .reminders.createReminder)
struct AddTaskReminderIntent {
    static let openAppWhenRun = true
    var title: String
    var list: TaskList?
    var note: AttributedString?
    var isFlagged: Bool?
    var images: [IntentFile]
    var tags: Set<String>
    var urls: [URL]
    var dueDate: DateComponents?
    var recurrence: Calendar.RecurrenceRule?
    var locationTrigger: TaskPlace?
    var section: TaskSection?

    @MainActor func perform() async throws -> some ReturnsValue<TaskReminder> {
        try DueDay.refuse(["note": note != nil, "flag": isFlagged == true, "images": !images.isEmpty, "tags": !tags.isEmpty, "links": !urls.isEmpty,
                           "repeat": recurrence != nil, "place": locationTrigger != nil, "sections": section != nil])
        let words = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { throw Engine.Failure(errorDescription: "A task needs a title") }
        let today = try DueDay.pins(dueDate), list = list ?? .plain
        let id = try await engine().createTask(words, type: list.taskType, today: today)
        return .result(value: TaskReminder(id: id, title: words, isCompleted: false, today: today, list: list))
    }
}

@available(iOS 27, *)
@AppIntent(schema: .reminders.updateReminder)
struct UpdateTaskReminderIntent {
    static let openAppWhenRun = true
    var target: TaskReminder
    var title: String?
    var note: AttributedString?
    var tags: Set<String>?
    var urls: [URL]?
    var dueDate: DateComponents?
    var recurrence: Calendar.RecurrenceRule?
    var isCompleted: Bool?
    var isFlagged: Bool?
    var list: TaskList?
    var locationTrigger: TaskPlace?

    @MainActor func perform() async throws -> some ReturnsValue<TaskReminder> {
        try DueDay.refuse(["note": note != nil, "flag": isFlagged == true, "tags": !(tags ?? []).isEmpty, "links": !(urls ?? []).isEmpty,
                           "repeat": recurrence != nil, "place": locationTrigger != nil])
        if let title, title != target.title { throw Engine.Failure(errorDescription: "Orbital on iPhone does not rename tasks yet") }
        if let list, list.id != target.list.id { throw Engine.Failure(errorDescription: "Orbital on iPhone does not change a task's type yet") }
        let engine = try await engine(), today = try DueDay.pins(dueDate)
        let task = target // its properties are Siri's own, set in place
        if let isCompleted, isCompleted != target.isCompleted { await engine.tick(target.id, to: isCompleted ? "closed" : "open"); task.isCompleted = isCompleted }
        if today { await engine.pin(target.id, true); task.dueDate = DueDay.today }
        return .result(value: task)
    }
}

// to Tana's trash, as the long press's Delete (Engine.remove), after Siri asks
@available(iOS 27, *)
@AppIntent(schema: .reminders.deleteReminders)
struct DeleteTaskRemindersIntent {
    static let openAppWhenRun = true
    var entities: [TaskReminder]

    @MainActor func perform() async throws -> some IntentResult {
        let engine = try await engine()
        for task in entities where !(await engine.remove(task.id)) {
            throw Engine.Failure(errorDescription: engine.error ?? "Tana did not delete “\(task.title)”")
        }
        return .result()
    }
}
#endif
