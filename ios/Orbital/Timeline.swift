import SwiftUI

// One row of the Timeline page as main/timeline.js pageOf builds it for the desktop renderer; only what this draws.
struct Row: Decodable, Identifiable {
    let id: String
    let text: String?
    let title: String?
    let segments: [Segment]?
    let icon: String?
    let createdAt: String?
    let unread: Bool?
    let done: Bool?
    let subtext: String?
    let start: String?
    let join: String?
    let people: [Person]?
    let children: [Row]?
    let timeline: Info?

    struct Segment: Decodable { let text: String; let marks: Marks? }
    struct Marks: Decodable { let bold: Bool?; let strike: Bool? }
    struct Person: Decodable { let name: String }
    struct Free: Decodable { let from: Double; let until: Double }
    struct Info: Decodable {
        let uri: String?
        let note: String?
        let change: String?
        let detail: String?
        let tone: String?
        let today: Bool?
        let upcoming: Bool?
        let free: Free?
    }

    var date: Date { createdAt.flatMap { try? Date($0, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)) } ?? .now }
    var words: String { title ?? text ?? "" }
    var tone: String? { timeline?.tone }

    var styled: AttributedString {
        (segments ?? [Segment(text: words, marks: nil)]).reduce(into: AttributedString()) { out, s in
            var a = AttributedString(s.text)
            if s.marks?.bold == true { a.inlinePresentationIntent = .stronglyEmphasized }
            if s.marks?.strike == true { a.strikethroughStyle = .single; a.foregroundColor = .secondary }
            out += a
        }
    }
}

// The Timeline as an outline, the way Reminders lists: a marker in a fixed gutter, the sentence, its grey lines under it,
// the time on the right, hairlines that start where the words do. Today's Tasks and Coming up sit above the days, each
// only when it has something in it. Colour only where it means something (docs: orbital-design, Grey unless colour means
// something): green for done, blue for new and for a meeting under way.
struct TimelineScreen: View {
    let engine: Engine
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            List {
                if !today.isEmpty {
                    Section("Today's tasks") { ForEach(today) { TaskRow(row: $0, open: open) } }
                }
                if !upcoming.isEmpty || free != nil {
                    Section("Coming up") {
                        if let free { FreeLine(free: free) }
                        ForEach(upcoming) { Meeting(row: $0, open: open) }
                    }
                }
                ForEach(days, id: \.0) { title, rows in
                    Section(title) { ForEach(rows) { Entry(row: $0, open: open) } }
                }
                if !days.isEmpty {
                    Button { Task { await engine.more() } } label: {
                        Text(engine.loading ? "Loading…" : "Show three more days").frame(maxWidth: .infinity)
                    }
                    .foregroundStyle(.secondary)
                    .disabled(engine.loading)
                    .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .refreshable { await engine.refresh() }
            .navigationTitle("Timeline")
            .overlay {
                if engine.rows.isEmpty {
                    if engine.loading { ProgressView() }
                    else if let error = engine.error { ContentUnavailableView("Timeline didn't load", systemImage: "exclamationmark.triangle", description: Text(error)) }
                    else { ContentUnavailableView("Nothing yet", systemImage: "clock", description: Text("Changes to your tasks, new Inbox tasks and your meetings show up here.")) }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if let error = engine.error, !engine.rows.isEmpty {
                    Text(error).font(.footnote).foregroundStyle(.secondary).padding(8).frame(maxWidth: .infinity).background(.bar)
                }
            }
        }
    }

    private var today: [Row] { engine.rows.first { $0.timeline?.today == true }?.children ?? [] }
    private var upcoming: [Row] { engine.rows.first { $0.timeline?.upcoming == true }?.children ?? [] }
    private var free: Row.Free? { engine.rows.first { $0.timeline?.free != nil }?.timeline?.free }

    // Today, Yesterday and each day before, by the rows' own time (renderer/timeline.js timelineGroups)
    private var days: [(String, [Row])] {
        var out: [(String, [Row])] = []
        for row in engine.rows where row.timeline?.today != true && row.timeline?.upcoming != true && row.timeline?.free == nil {
            let title = Self.day(row.date)
            if out.last?.0 == title { out[out.count - 1].1.append(row) } else { out.append((title, [row])) }
        }
        return out
    }

    private static func day(_ d: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(d) { return "Today" }
        if cal.isDateInYesterday(d) { return "Yesterday" }
        return d.formatted(.dateTime.weekday(.wide).day().month(.wide))
    }

    private func open(_ id: String) {
        Task { if let url = await engine.link(id) { openURL(url) } }
    }
}

// What happened: the sentence with its verb in bold, Tana's words about it under that, faces for a meeting, the tasks
// an Inbox line brought. A meeting with no write-up is drawn quiet (#214); a new one carries the blue dot.
struct Entry: View {
    let row: Row
    let open: (String) -> Void

    var body: some View {
        let quiet = row.tone == "faint"
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Marker(icon: row.icon, tone: row.tone, now: row.join != nil)
            VStack(alignment: .leading, spacing: 3) {
                Text(row.styled).foregroundStyle(quiet ? .secondary : .primary)
                ForEach([row.timeline?.note, row.timeline?.change, row.timeline?.detail].compactMap { $0 }, id: \.self) {
                    Text($0).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
                }
                if let people = row.people, !people.isEmpty { Faces(people: people).padding(.top, 2) }
                ForEach(row.children ?? []) { child in TaskRow(row: child, open: open).padding(.top, 4) }
            }
            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 6) {
                Text(row.date, format: .dateTime.hour().minute()).font(.footnote).monospacedDigit().foregroundStyle(.secondary)
                if row.unread == true { Circle().fill(.blue).frame(width: 8, height: 8).accessibilityLabel("New") }
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onTapGesture { if let uri = row.timeline?.uri { open(uri) } }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(row.timeline?.uri != nil ? .isButton : [])
    }
}

// A task: its box and its words, struck and grey once done. The box is for ticking off, which comes with the sync
// stream (#660); read-only until then.
struct TaskRow: View {
    let row: Row
    let open: (String) -> Void

    var body: some View {
        let done = row.done == true
        Button { open(row.id) } label: {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Image(systemName: done ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(done ? AnyShapeStyle(.green) : AnyShapeStyle(.tertiary))
                    .frame(width: 22)
                Text(row.words).strikethrough(done).foregroundStyle(done ? .secondary : .primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(row.words + (done ? ", completed" : ""))
    }
}

// A meeting still to come today: its name, when, and who else is on it as faces
struct Meeting: View {
    let row: Row
    let open: (String) -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Marker(icon: "meeting", tone: nil, now: false)
            VStack(alignment: .leading, spacing: 3) {
                Text(row.words)
                if let people = row.people, !people.isEmpty { Faces(people: people).padding(.top, 2) }
            }
            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
            Spacer(minLength: 8)
            Text(row.subtext ?? "").font(.footnote).monospacedDigit().foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onTapGesture { open(row.id) }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

// The free time before the next meeting, counted down while it shows (renderer/timeline.js timelineFreeSegs)
struct FreeLine: View {
    let free: Row.Free

    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { context in
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Marker(icon: "free", tone: nil, now: false)
                Text(Self.text(free, now: context.date)).foregroundStyle(.secondary)
                    .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
            }
            .padding(.vertical, 4)
        }
    }

    static func text(_ f: Row.Free, now date: Date) -> AttributedString {
        let now = date.timeIntervalSince1970 * 1000, later = f.from > now
        let m = max(1, Int(((f.until - max(now, f.from)) / 60000).rounded(.up)))
        let left = m < 60 ? "\(m) \(later ? "" : "more ")min" : "\(m / 60) h" + (m % 60 > 0 ? " \(m % 60) min" : "")
        var bold = AttributedString(left)
        bold.inlinePresentationIntent = .stronglyEmphasized
        return AttributedString("No meetings for ") + bold + AttributedString(later ? " after this one" : "")
    }
}

// People as faces (#461): initials in grey circles, overlapping, four at most, then the count; the names follow when
// there are few
struct Faces: View {
    let people: [Row.Person]

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: -4) {
                ForEach(people.prefix(4), id: \.name) { p in
                    Text(Self.initials(p.name))
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 24, height: 24)
                        .background(Circle().fill(Color(.systemGray5)))
                        .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 1.5))
                }
            }
            Text(people.count <= 2 ? people.map(\.name).joined(separator: ", ") : "\(people.count) people")
                .font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(people.map(\.name).joined(separator: ", "))
    }

    static func initials(_ name: String) -> String {
        name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    }
}

// The marker in the gutter (main/timeline.js ICON), one grey shade like the desktop's rail (#217): green only for done,
// blue for a meeting under way. Orbital's own glyphs replace these SF Symbols in #661.
struct Marker: View {
    let icon: String?
    let tone: String?
    let now: Bool

    var body: some View {
        Image(systemName: symbol)
            .symbolRenderingMode(.monochrome)
            .foregroundStyle(tone == "done" ? AnyShapeStyle(.green) : now ? AnyShapeStyle(.blue) : AnyShapeStyle(.secondary))
            .frame(width: 22)
            .accessibilityHidden(true)
    }

    private var symbol: String {
        switch icon {
        case "apply": "checkmark.circle.fill"
        case "tlAccepted": "arrow.forward.circle"
        case "tlLater": "moon"
        case "tlInbox": "tray"
        case "updated": "pencil"
        case "robot": "cpu"
        case "tana": "sparkles"
        case "tlNew": "plus.circle"
        case "meeting": "calendar"
        case "free": "cup.and.saucer"
        default: "circle"
        }
    }
}
