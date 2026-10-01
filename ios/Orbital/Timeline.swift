import SwiftUI

// One row as the desktop renderer gets it: of the Timeline (main/timeline.js), a saved search or a meeting's documents
// (ios/engine/index.js listRow), an outline (sdk/content.js) or a chat (sdk/chat.js); only what this draws.
struct Row: Decodable, Identifiable {
    let id: String
    let text: String?
    let title: String?
    let segments: [Segment]?
    let icon: String?
    let createdAt: String?
    let unread: Bool?
    let done: Bool?
    let stateType: String?
    let subtext: String?
    let start: String?
    let join: String?
    let people: [Person]?
    let children: [Row]?
    let timeline: Info?
    let reference: Ref?
    let heading: Int?
    let block: String?
    let type: String?
    let meta: String?
    let note: Bool?
    let chat: Chat?
    let group: String? // the section a saved search files it under (ios/engine/arrange.js)
    let glyph: String? // a saved search's own icon, a PNG in base64 (ios/engine/index.js iconPng)

    struct Segment: Decodable { let text: String?; let marks: Marks?; let mention: Ref? }
    struct Marks: Decodable { let bold: Bool?; let italic: Bool?; let strike: Bool?; let code: Bool?; let link: String? }
    struct Ref: Decodable { let uri: String; let label: String? }
    struct Chat: Decodable { let mine: Bool?; let status: Bool?; let streaming: Bool?; let author: String? }
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

    var date: Date { createdAt.flatMap(Self.parse) ?? .now }
    // Tana's times, with or without fractional seconds ("2026-09-30T13:00:00Z", "…:00.000Z")
    static func parse(_ s: String) -> Date? {
        (try? Date(s, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true))) ?? (try? Date(s, strategy: .iso8601))
    }
    var words: String { [title, text, reference?.label].compactMap { $0 }.first { !$0.isEmpty } ?? "" }
    var tone: String? { timeline?.tone }
    // the node a tap on this row zooms into: what it refers to, or the row itself when it is a node (an outline block's
    // own id is not)
    var target: String? { reference?.uri ?? (id.hasPrefix("tana:") ? id : nil) }

    // The words with their marks. A mention and a link to a node are links to orbital:<id>, which the shell zooms into;
    // any other link opens as it would anywhere.
    var styled: AttributedString {
        let list = segments.flatMap { $0.isEmpty ? nil : $0 } ?? [Segment(text: words, marks: nil, mention: nil)]
        return list.reduce(into: AttributedString()) { out, s in
            var a = AttributedString(s.text ?? s.mention?.label ?? "")
            if let m = s.mention { a.link = Self.zoom(m.uri) }
            if s.marks?.bold == true { a.inlinePresentationIntent = .stronglyEmphasized }
            if s.marks?.italic == true { a.inlinePresentationIntent = (a.inlinePresentationIntent ?? []).union(.emphasized) }
            if s.marks?.code == true { a.inlinePresentationIntent = (a.inlinePresentationIntent ?? []).union(.code) }
            if s.marks?.strike == true { a.strikethroughStyle = .single; a.foregroundColor = .secondary }
            if let href = s.marks?.link { a.link = href.hasPrefix("tana:") ? Self.zoom(href) : URL(string: href) }
            out += a
        }
    }
    static func zoom(_ id: String) -> URL? { URL(string: "orbital:" + id) }
}

// Zooming into a node from anywhere: the shell's openURL pushes an orbital:<id> link (Shell)
extension OpenURLAction {
    func zoom(_ id: String?) { if let url = id.flatMap(Row.zoom) { callAsFunction(url) } }
}

// Long press on a node: Delete, to Tana's trash where you may delete it (Engine.remove); done reads the page again
extension View {
    func deletable(_ id: String?, engine: Engine, then done: @escaping () async -> Void = {}) -> some View {
        contextMenu {
            if let id, id.hasPrefix("tana:") {
                Button("Delete", systemImage: "trash", role: .destructive) { Task { if await engine.remove(id) { await done() } } }
            }
        }
    }
}

// The Timeline as the desktop draws it (styles.css .node.tl): the time on the left, a marker on a thin rail that runs
// the length of the page, what happened to the right. Today's tasks and Coming up sit on the same rail above the days,
// each only when it has something in it. Colour only where it means something (orbital-design, Grey unless colour
// means something): Orbital's green for done, blue for new and for a meeting under way.
struct TimelineScreen: View {
    let engine: Engine

    var body: some View {
        List {
            if !today.isEmpty {
                // one stop on the rail, as the desktop's: Now, the Today glyph, its words, the tasks hanging under them
                RailRow(time: "Now", railTop: 24) { Marker(icon: "todayTasks", tone: "new", now: false) } content: {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Today's Tasks")
                        TaskList(tasks: today, engine: engine)
                    }
                }
                .accessibilityElement(children: .contain)
            }
            if !upcoming.isEmpty || free != nil {
                Heading(title: "Coming up")
                if let free { FreeLine(free: free, time: today.isEmpty ? "Now" : "") }
                ForEach(upcoming) { Meeting(row: $0, engine: engine) }
            }
            ForEach(days, id: \.0) { title, rows in
                Heading(title: title)
                ForEach(rows) { Entry(row: $0, engine: engine) }
            }
            // always, as the desktop has it: a quiet three days must not hide the days before them
            if !engine.rows.isEmpty {
                Button { Task { await engine.more() } } label: {
                    Text(engine.loading ? "Loading…" : "Show three more days").frame(maxWidth: .infinity)
                }
                .foregroundStyle(.secondary)
                .disabled(engine.loading)
                .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .scrollDismissesKeyboard(.interactively) // scrolling the Timeline tucks the composer's keyboard away
        .refreshable { await engine.refresh() }
        // the free time ends when the next meeting starts: read the page again then, so neither stays on screen past it
        .task(id: free?.until) {
            guard let until = free?.until else { return }
            try? await Task.sleep(for: .seconds(max(1, until / 1000 - Date.now.timeIntervalSince1970)))
            if !Task.isCancelled { await engine.refresh() }
        }
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
}

// A section's heading: a row of its own between two stretches of rail, its words in the middle of the gap. Not a
// sticky List header, whose extra space above sat the words low and whose pinned band cut the top bar off.
struct Heading: View {
    let title: String
    var body: some View {
        Text(title).font(.headline).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 16))
            .listRowSeparator(.hidden)
            .accessibilityAddTraits(.isHeader)
    }
}

// The rail's geometry: the time column, the marker's column, and where the line runs (through the markers' middle)
enum Rail {
    static let inset: CGFloat = 12
    static let time: CGFloat = 42
    static let marker: CGFloat = 24
    static let gap: CGFloat = 10
    static let line = time + gap + marker / 2 - 0.5
}

// One stop on the rail. The line is the row's background, which fills the whole row, so each row's piece meets the
// next and the rail reads as one line down the section; rows carry no separators.
struct RailRow<Dot: View, Content: View>: View {
    let time: String
    var railTop: CGFloat = 0 // where the line starts: the first stop's starts at its marker, as the desktop's does
    @ViewBuilder let marker: Dot
    @ViewBuilder let content: Content

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Rail.gap) {
            Text(time).font(.footnote).monospacedDigit().foregroundStyle(.secondary).frame(width: Rail.time, alignment: .trailing)
            marker.frame(width: Rail.marker)
            content.frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 14)
        .contentShape(Rectangle())
        .listRowInsets(EdgeInsets(top: 0, leading: Rail.inset, bottom: 0, trailing: 16))
        .listRowSeparator(.hidden)
        .listRowBackground(HStack(spacing: 0) { Color.clear.frame(width: Rail.inset + Rail.line); Color(.separator).frame(width: 1).padding(.top, railTop); Spacer(minLength: 0) })
    }
}

// What happened: the sentence with its verb in bold, Tana's words about it under that, faces for a meeting, the tasks
// an Inbox line brought. A meeting with no write-up is drawn quiet (#214); a new one carries the blue dot.
struct Entry: View {
    let row: Row
    let engine: Engine
    @Environment(\.openURL) private var openURL

    var body: some View {
        let quiet = row.tone == "faint"
        RailRow(time: row.date.formatted(.dateTime.hour().minute())) {
            Marker(icon: row.icon, tone: row.tone, now: row.join != nil)
        } content: {
            VStack(alignment: .leading, spacing: 3) {
                Text(row.styled).foregroundStyle(quiet ? .secondary : .primary)
                ForEach([row.timeline?.note, row.timeline?.change, row.timeline?.detail].compactMap { $0 }, id: \.self) {
                    Text($0).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
                }
                if let people = row.people, !people.isEmpty { Faces(people: people).padding(.top, 2) }
                if let tasks = row.children, !tasks.isEmpty { TaskList(tasks: tasks, engine: engine) }
            }
            .padding(.trailing, row.unread == true ? 18 : 0) // the new dot's own room: a full-width sentence ran under it
            .overlay(alignment: .topTrailing) {
                if row.unread == true { Circle().fill(.blue).frame(width: 8, height: 8).offset(y: 7).accessibilityLabel("New") }
            }
        }
        .onTapGesture { openURL.zoom(row.timeline?.uri) }
        .deletable(row.timeline?.uri, engine: engine)
        // one element to VoiceOver, unless it lists tasks, whose boxes have to stay reachable
        .accessibilityElement(children: row.children?.isEmpty == false ? .contain : .combine)
        .accessibilityAddTraits(row.timeline?.uri != nil ? .isButton : [])
        .accessibilityAction { openURL.zoom(row.timeline?.uri) } // VoiceOver's double tap: a tap gesture is not one
    }
}

// A task's box, the desktop's square. A tap ticks it off or back on
// (Engine.toggle, the desktop's rule), with the success haptic; the words beside it open the task.
struct TaskBox: View {
    let task: Row
    let engine: Engine
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let state = engine.state(of: task)
        Button { Task { await engine.toggle(task) } } label: {
            CheckBox(state: state)
                .padding(10).contentShape(Rectangle()).padding(-10) // a finger-sized target around a text-sized box
        }
        .buttonStyle(.plain)
        .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 4 } // centred on the first line, as the markers are
        .sensoryFeedback(.success, trigger: engine.states[task.id]) { _, now in now == "closed" } // your own tick, not a change read from Tana
        .animation(reduceMotion ? nil : .snappy, value: state)
        .accessibilityLabel(task.words)
        .accessibilityValue(state == "closed" ? "Completed" : state == "proposed" ? "In your Inbox" : "Not completed")
        .accessibilityHint("Ticks the task off, or back on")
    }
}

// The tasks an entry lists, hanging under its words: each its box and its words, with room above the list, between the
// tasks and under the last one so the next entry does not crowd them (styles.css .node.tl > .children)
struct TaskList: View {
    let tasks: [Row]
    let engine: Engine
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(tasks) { task in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    TaskBox(task: task, engine: engine)
                    Button { openURL.zoom(task.id) } label: { TaskWords(row: task, engine: engine).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle()) }
                        .buttonStyle(.plain)
                }
                .deletable(task.id, engine: engine)
            }
        }
        // as much room above the list as under it: under it the entry's own 14 pt and the next one's 14 pt come on top of this
        .padding(.top, 26)
        .padding(.bottom, 2)
    }
}

// The desktop's box (styles.css .check): a grey rounded square, green with a white tick once done, a dashed outline for
// an Inbox task (its first tap accepts it)
struct CheckBox: View {
    let state: String

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 5.5, style: .continuous)
        ZStack {
            if state == "proposed" {
                shape.strokeBorder(Color.pair(0xc8c8c8, 0x5d6467), style: StrokeStyle(lineWidth: 1.2, dash: [2.6, 2.4]))
            } else {
                shape.fill(state == "closed" ? Color.pair(0x6fae82, 0x5b976c) : Color.pair(0xe4e4e4, 0x3a3e40))
            }
            if state == "closed" { Tick().stroke(.white, style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round)).transition(.scale) }
        }
        .frame(width: 20, height: 20)
    }
}

// the desktop's tick (M4 8.7 l3.3 3.3 6.9-6.9 in an 18 box), drawn to whatever box it is given
struct Tick: Shape {
    func path(in rect: CGRect) -> Path {
        let s = rect.width / 18
        var p = Path()
        p.move(to: CGPoint(x: 4 * s, y: 8.7 * s))
        p.addLine(to: CGPoint(x: 7.3 * s, y: 12 * s))
        p.addLine(to: CGPoint(x: 14.2 * s, y: 5.1 * s))
        return p
    }
}

// A task's words, struck and grey once done; in the chosen language when they are in another (a globe says so)
struct TaskWords: View {
    let row: Row
    let engine: Engine
    var body: some View {
        let done = engine.state(of: row) == "closed", (words, from) = engine.translator.words(row.words)
        (Text(words) + Text(from == nil ? "" : "  \(Image(systemName: "globe"))").font(.footnote).foregroundStyle(.tertiary))
            .strikethrough(done).foregroundStyle(done ? .secondary : .primary)
            .accessibilityHint(from.map { "Translated from " + $0 } ?? "")
    }
}

// A meeting still to come today: when on the left, its name, until when, and who else is on it as faces
struct Meeting: View {
    let row: Row
    let engine: Engine
    @Environment(\.openURL) private var openURL

    var body: some View {
        let start = row.start.flatMap(Row.parse)
        RailRow(time: start?.formatted(.dateTime.hour().minute()) ?? "") {
            Marker(icon: "meeting", tone: nil, now: false)
        } content: {
            VStack(alignment: .leading, spacing: 3) {
                Text(engine.translator.words(row.words).0)
                if let until = row.subtext?.split(separator: "–").last { Text("until " + until).font(.subheadline).foregroundStyle(.secondary) }
                if let people = row.people, !people.isEmpty { Faces(people: people).padding(.top, 2) }
            }
        }
        .onTapGesture { openURL.zoom(row.id) }
        .deletable(row.id, engine: engine)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { openURL.zoom(row.id) }
    }
}

// The free time before the next meeting, counted down while it shows (renderer/timeline.js timelineFreeSegs)
struct FreeLine: View {
    let free: Row.Free
    var time = "Now"

    var body: some View {
        RailRow(time: time) { Marker(icon: "free", tone: "new", now: false) } content: {
            TimelineView(.periodic(from: .now, by: 15)) { context in Text(Self.text(free, now: context.date)).foregroundStyle(.secondary) }
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

// Orbital's green for finished work (styles.css .tl-done), the same on every task box
extension Color {
    static let done = Color(red: 0x5a / 255, green: 0x96 / 255, blue: 0x70 / 255)
    // one of the desktop's light colours and its dark twin (styles.css and its [data-theme="dark"] rules)
    static func pair(_ light: UInt32, _ dark: UInt32) -> Color {
        let rgb = { (v: UInt32) in UIColor(red: CGFloat(v >> 16 & 0xff) / 255, green: CGFloat(v >> 8 & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1) }
        return Color(UIColor { $0.userInterfaceStyle == .dark ? rgb(dark) : rgb(light) })
    }
}

// The marker in the gutter, as the desktop's rail draws it (main/timeline.js ICON, styles.css .tl-*): the Nucleo glyphs
// of icons.js (scripts/build-ios-glyphs.js) in one grey (#217). Finished work is a green disc with a white check, a new
// task and a meeting with no write-up are quieter, and a meeting under way is blue.
struct Marker: View {
    let icon: String?
    let tone: String?
    let now: Bool

    var body: some View {
        Group {
            if tone == "done" {
                Image("Glyphs/applyDone").resizable().frame(width: 12, height: 12).foregroundStyle(.white)
                    .frame(width: 20, height: 20).background(Circle().fill(Color.done))
            } else {
                Image("Glyphs/" + glyph).resizable().frame(width: 20, height: 20)
                    .foregroundStyle(now ? AnyShapeStyle(.blue) : tone == "new" || tone == "faint" ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.secondary))
                    .background(Circle().fill(Color(.systemBackground)).padding(-2)) // the rail passes behind the glyph, as on the desktop
            }
        }
        .frame(width: 22)
        .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 4 } // centred on the first line's lower-case letters
        .accessibilityHidden(true)
    }

    private var glyph: String {
        switch icon {
        case "tlAccepted", "tlLater", "tlInbox", "tlNew", "updated", "robot", "tana", "free", "todayTasks": icon!
        default: "calendar" // a meeting (the desktop draws its type's glyph, calendar)
        }
    }
}
