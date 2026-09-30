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

    // Today's Tasks, the free time and Upcoming meetings sit above the history
    var isTop: Bool { timeline?.today == true || timeline?.upcoming == true || timeline?.free != nil }
    var date: Date { createdAt.flatMap { try? Date($0, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)) } ?? .now }
    var words: String { title ?? text ?? "" }

    var styled: AttributedString {
        if let free = timeline?.free { return Self.freeText(free) }
        return (segments ?? [Segment(text: words, marks: nil)]).reduce(into: AttributedString()) { out, s in
            var a = AttributedString(s.text)
            if s.marks?.bold == true { a.inlinePresentationIntent = .stronglyEmphasized }
            if s.marks?.strike == true { a.strikethroughStyle = .single }
            out += a
        }
    }

    // renderer/timeline.js timelineFreeSegs, in short
    static func freeText(_ f: Free) -> AttributedString {
        let now = Date.now.timeIntervalSince1970 * 1000, later = f.from > now
        let m = max(1, Int(((f.until - max(now, f.from)) / 60000).rounded(.up)))
        let left = m < 60 ? "\(m) \(later ? "" : "more ")min" : "\(m / 60) h" + (m % 60 > 0 ? " \(m % 60) min" : "")
        var bold = AttributedString(left)
        bold.inlinePresentationIntent = .stronglyEmphasized
        return AttributedString("No meetings for ") + bold + AttributedString(later ? " after this one" : "")
    }
}

struct TimelineScreen: View {
    let engine: Engine
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            List {
                ForEach(sections, id: \.0) { title, rows in
                    Section(title) {
                        ForEach(rows) { row in EntryRow(row: row, open: open) }
                    }
                }
                if !engine.rows.isEmpty {
                    Button { Task { await engine.more() } } label: {
                        Label(engine.loading ? "Loading…" : "Three more days", systemImage: "clock.arrow.circlepath")
                    }
                    .disabled(engine.loading)
                }
            }
            .listStyle(.insetGrouped)
            .refreshable { await engine.refresh() }
            .navigationTitle("Timeline")
            .overlay {
                if engine.rows.isEmpty {
                    if engine.loading { ProgressView() }
                    else if let error = engine.error { ContentUnavailableView("Timeline didn't load", systemImage: "exclamationmark.triangle", description: Text(error)) }
                    else { ContentUnavailableView("Nothing yet", systemImage: "clock", description: Text("Changes to your tasks, new Inbox tasks and meetings show up here.")) }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if let error = engine.error, !engine.rows.isEmpty {
                    Text(error).font(.footnote).foregroundStyle(.secondary).padding(8).frame(maxWidth: .infinity).background(.bar)
                }
            }
        }
    }

    // Now, then Today, Yesterday and each day before by the rows' own time (renderer/timeline.js timelineGroups)
    private var sections: [(String, [Row])] {
        var out: [(String, [Row])] = []
        let top = engine.rows.filter(\.isTop)
        if !top.isEmpty { out.append(("Now", top)) }
        for row in engine.rows where !row.isTop {
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

struct EntryRow: View {
    let row: Row
    let open: (String) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Marker(icon: row.icon, tone: row.timeline?.tone)
            VStack(alignment: .leading, spacing: 4) {
                Text(row.styled).font(.subheadline)
                ForEach([row.timeline?.note, row.timeline?.change, row.timeline?.detail].compactMap { $0 }, id: \.self) {
                    Text($0).font(.footnote).foregroundStyle(.secondary).lineLimit(4)
                }
                if let people = row.people, !people.isEmpty {
                    Text(people.map(\.name).joined(separator: ", ")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                ForEach(row.children ?? []) { child in
                    Button { open(child.id) } label: { Child(row: child) }.buttonStyle(.borderless)
                }
            }
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 6) {
                if !row.isTop { Text(row.date, format: .dateTime.hour().minute()).font(.caption).monospacedDigit().foregroundStyle(.secondary) }
                if row.unread == true { Circle().fill(.blue).frame(width: 8, height: 8).accessibilityLabel("New") }
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onTapGesture { if let uri = row.timeline?.uri { open(uri) } }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(row.timeline?.uri != nil ? .isButton : [])
    }
}

// A task under Today's Tasks or an Inbox line, or a meeting under Upcoming meetings
struct Child: View {
    let row: Row
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if row.subtext != nil {
                Image(systemName: "calendar").foregroundStyle(.secondary)
            } else {
                Image(systemName: row.done == true ? "checkmark.circle.fill" : "circle").foregroundStyle(row.done == true ? .green : .secondary)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(row.words).strikethrough(row.done == true).foregroundStyle(row.done == true ? .secondary : .primary)
                if let sub = row.subtext { Text(sub).font(.caption).foregroundStyle(.secondary) }
            }
        }
        .font(.subheadline)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// The marker on the desktop's rail (main/timeline.js ICON), as SF Symbols
struct Marker: View {
    let icon: String?
    let tone: String?

    var body: some View {
        Image(systemName: symbol)
            .font(.title3)
            .foregroundStyle(color)
            .frame(width: 24)
            .accessibilityHidden(true)
    }

    private var symbol: String {
        switch icon {
        case "apply": "checkmark.circle.fill"
        case "tlAccepted": "play.circle.fill"
        case "tlLater": "moon.circle.fill"
        case "tlInbox": "tray.circle.fill"
        case "updated": "pencil.circle.fill"
        case "robot": "cpu"
        case "tana": "sparkles"
        case "tlNew": "circle.dotted"
        case "meeting": "person.2.circle.fill"
        case "todayTasks": "sun.max.fill"
        case "free": "cup.and.saucer.fill"
        default: "circle.fill"
        }
    }

    private var color: Color {
        switch tone {
        case "done": .green
        case "accepted": .blue
        case "meeting": .purple
        case "faint", "quiet": .secondary
        case "new": .orange
        default: .gray
        }
    }
}

