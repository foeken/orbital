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
    let assignees: [String]? // a task's, in a saved search: who it is assigned to, for Assign to …
    let children: [Row]?
    let timeline: Info?
    let reference: Ref?
    let heading: Int?
    let block: String?
    let type: String?
    let meta: String?
    let note: Bool?
    let chat: Chat?
    let sensitive: Bool? // marked sensitive in Orbital: drawn blurred until a shake shows it (ios/engine/sensitive.js)
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

// Long press on a node: pin it to today or take it off, mark it sensitive or not, or delete it to Tana's trash where you
// may (Engine.pin, markSensitive, remove); done reads the page again
extension View {
    // task: the row is a task, which offers Assign to …; assignees: who has it, when known (a saved search's rows)
    func nodeMenu(_ id: String?, engine: Engine, task: Bool = false, assignees: [String]? = nil, then done: @escaping () async -> Void = {}) -> some View {
        contextMenu {
            if let id, id.hasPrefix("tana:") {
                if task { Button("Assign to …", systemImage: "person.crop.circle") { engine.assigning = .init(id: id, current: assignees, then: done) } }
                let pinned = engine.pinnedToday.contains(id), secret = engine.sensitiveIds.contains(id)
                Button(pinned ? "Unpin from Today" : "Pin to Today", systemImage: pinned ? "pin.slash" : "pin") { Task { await engine.pin(id, !pinned); await done() } }
                Button(secret ? "Not Sensitive" : "Mark as Sensitive", systemImage: secret ? "eye" : "eye.slash") { Task { await engine.markSensitive(id, !secret); await done() } }
                Divider()
                Button("Delete", systemImage: "trash", role: .destructive) { Task { if await engine.remove(id) { await done() } } }
            }
        }
    }

    // What is sensitive, drawn as the desktop draws it, until a shake of the phone shows it (Engine.reveal)
    func sensitive(_ on: Bool?, engine: Engine) -> some View {
        modifier(Blur(hidden: on == true && !engine.reveal))
    }
}

struct Blur: ViewModifier {
    let hidden: Bool
    func body(content: Content) -> some View {
        if hidden {
            content.textRenderer(Redacted()).accessibilityElement(children: .ignore).accessibilityLabel("Sensitive, shake to show")
        } else {
            content
        }
    }
}

// The desktop's sensitive text (styles.css .sensitive): no letters, a grey bar through each line where they were, 0.72 em
// thick across the line-through, in #696d73 at 14 %. Every Text under it is drawn this way.
struct Redacted: TextRenderer {
    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        for line in layout {
            let b = line.typographicBounds, em = (b.ascent + b.descent) / 1.2 // a line is about 1.2 em
            let bar = CGRect(x: b.rect.minX, y: b.rect.minY + b.ascent - 0.3 * em - 0.36 * em, width: b.rect.width, height: 0.72 * em)
            context.fill(Path(roundedRect: bar, cornerRadius: 0.12 * em), with: .color(Color(red: 0x69 / 255, green: 0x6d / 255, blue: 0x73 / 255).opacity(0.14)))
        }
    }
}

// The Timeline as the desktop draws it (styles.css .node.tl): the time on the left, a marker on a thin rail that runs
// the length of the page, what happened to the right. Today's tasks, the free time and Upcoming meetings sit on the same rail above the days,
// each only when it has something in it. Colour only where it means something (orbital-design, Grey unless colour
// means something): Orbital's green for done, blue for new and for a meeting under way.
struct TimelineScreen: View {
    let engine: Engine
    @State private var shown = true // the rows: hidden while the skeleton is up, and in only once it has gone

    var body: some View {
        List {
            if !today.isEmpty {
                // one stop on the rail, as the desktop's: Now, the Today glyph, its words, the tasks hanging under them
                RailRow(time: "Now", railTop: 24, bottom: 0) { Marker(icon: "todayTasks", tone: "new", now: false) } content: { Text("Today's Tasks") }
                TaskLines(tasks: today, engine: engine)
            }
            // as the desktop has it: the free time, then one stop for the meetings still to come, each hanging under it like
            // a task, its start time on its right (the rail's own time column says only Now)
            if let free { FreeLine(free: free, time: today.isEmpty ? "Now" : "") }
            if !upcoming.isEmpty {
                RailRow(time: "", top: 14, bottom: 0) { Marker(icon: "meeting", tone: nil, now: false) } content: { Text("Upcoming meetings") }
                ForEach(Array(upcoming.enumerated()), id: \.element.id) { i, m in Meeting(row: m, engine: engine, top: i == 0 ? 20 : 14, bottom: i == upcoming.count - 1 ? 16 : 0) }
            }
            if !upcoming.isEmpty || free != nil {
                // a line across under what is still to come, before what has happened
                if !days.isEmpty {
                    Color(.separator).frame(maxWidth: .infinity).frame(height: 1) // a List row lays a Divider out upright
                        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 16))
                        .listRowSeparator(.hidden)
                        .accessibilityHidden(true)
                }
            }
            ForEach(days, id: \.0) { title, rows in
                Heading(title: title)
                ForEach(rows) { row in
                    Entry(row: row, engine: engine)
                    TaskLines(tasks: row.children ?? [], engine: engine)
                }
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
        // never the skeleton and the words on screen together: it goes in 0.15 s, then the rows come in
        .opacity(shown ? 1 : 0)
        .onChange(of: building, initial: true) { _, now in
            if now { shown = false } else { withAnimation(.easeIn(duration: 0.25).delay(0.15)) { shown = true } }
        }
        .scrollDismissesKeyboard(.interactively) // scrolling the Timeline tucks the composer's keyboard away
        .refreshable { await engine.refresh() }
        // the free time ends when the next meeting starts: read the page again then, so neither stays on screen past it
        .task(id: free?.until) {
            guard let until = free?.until else { return }
            try? await Task.sleep(for: .seconds(max(1, until / 1000 - Date.now.timeIntervalSince1970)))
            if !Task.isCancelled { await engine.refresh() }
        }
        .overlay {
            // connecting and the first read are one build, and it fades as the rows land under it
            ZStack {
                if building { Building().transition(.opacity) }
                else if engine.rows.isEmpty {
                if let error = engine.error { ContentUnavailableView("Timeline didn't load", systemImage: "exclamationmark.triangle", description: Text(error)) }
                else { ContentUnavailableView("Nothing yet", systemImage: "clock", description: Text("Changes to your tasks, new Inbox tasks and your meetings show up here.")) }
                }
            }
            .animation(.easeOut(duration: 0.15), value: building)
        }
        .safeAreaInset(edge: .bottom) {
            if let error = engine.error, !engine.rows.isEmpty {
                Text(error).font(.footnote).foregroundStyle(.secondary).padding(8).frame(maxWidth: .infinity).background(.bar)
            }
        }
    }

    // connecting and the first read are one build (Building)
    private var building: Bool { engine.rows.isEmpty && (engine.loading || engine.phase == .starting) }
    private var today: [Row] { engine.shown(engine.rows.first { $0.timeline?.today == true }?.children) }
    private var upcoming: [Row] { engine.shown(engine.rows.first { $0.timeline?.upcoming == true }?.children) }
    private var free: Row.Free? { engine.rows.first { $0.timeline?.free != nil }?.timeline?.free }

    // Today, Yesterday and each day before, by the rows' own time (renderer/timeline.js timelineGroups)
    private var days: [(String, [Row])] {
        var out: [(String, [Row])] = []
        for row in engine.shown(engine.rows) where row.timeline?.today != true && row.timeline?.upcoming != true && row.timeline?.free == nil {
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
    var top: CGFloat = 14, bottom: CGFloat = 14 // room above and below; an entry's tasks are rows of their own (TaskLines)
    @ViewBuilder let marker: Dot
    @ViewBuilder let content: Content

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Rail.gap) {
            Text(time).font(.footnote).monospacedDigit().foregroundStyle(.secondary).frame(width: Rail.time, alignment: .trailing)
            marker.frame(width: Rail.marker)
            content.frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.top, top)
        .padding(.bottom, bottom)
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
        RailRow(time: row.date.formatted(.dateTime.hour().minute()), bottom: engine.shown(row.children).isEmpty ? 14 : 0) {
            Marker(icon: row.icon, tone: row.tone, now: row.join != nil)
        } content: {
            VStack(alignment: .leading, spacing: 3) {
                Text(row.styled).foregroundStyle(quiet ? .secondary : .primary)
                ForEach([row.timeline?.note, row.timeline?.change, row.timeline?.detail].compactMap { $0 }, id: \.self) {
                    Text($0).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
                }
                if let people = row.people, !people.isEmpty { Faces(people: people).padding(.top, 2) }
            }
            .sensitive(row.sensitive, engine: engine)
            .padding(.trailing, row.unread == true ? 18 : 0) // the new dot's own room: a full-width sentence ran under it
            .overlay(alignment: .topTrailing) {
                if row.unread == true { Circle().fill(.blue).frame(width: 8, height: 8).offset(y: 7).accessibilityLabel("New") }
            }
        }
        .onTapGesture { openURL.zoom(row.timeline?.uri) }
        .nodeMenu(row.timeline?.uri, engine: engine)
        .accessibilityElement(children: .combine) // its tasks are rows of their own (TaskLines)
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

// The tasks an entry lists, hanging under its words, each a row of its own on the rail, so a long press is about that
// task alone: as much room above the first as under the last (with the next entry's own), more between them
// (styles.css .node.tl > .children)
struct TaskLines: View {
    let tasks: [Row]
    let engine: Engine

    var body: some View {
        let tasks = engine.shown(tasks)
        ForEach(Array(tasks.enumerated()), id: \.element.id) { i, task in
            TaskLine(task: task, engine: engine, top: i == 0 ? 26 : 16, bottom: i == tasks.count - 1 ? 16 : 0)
        }
    }
}

struct TaskLine: View {
    let task: Row
    let engine: Engine
    let top: CGFloat
    let bottom: CGFloat
    @Environment(\.openURL) private var openURL

    var body: some View {
        RailRow(time: "", top: top, bottom: bottom) { Color.clear.frame(height: 1) } content: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                TaskBox(task: task, engine: engine)
                Button { openURL.zoom(task.id) } label: { TaskWords(row: task, engine: engine).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle()) }
                    .buttonStyle(.plain)
            }
        }
        .nodeMenu(task.id, engine: engine, task: true, assignees: task.assignees)
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
        let done = engine.state(of: row) == "closed", (words, from) = engine.translator.words(row.words, sensitive: row.sensitive == true)
        (Text(words) + Text(from == nil ? "" : "  \(Image(systemName: "globe"))").font(.footnote).foregroundStyle(.tertiary))
            .strikethrough(done).foregroundStyle(done ? .secondary : .primary)
            .accessibilityHint(from.map { "Translated from " + $0 } ?? "")
            .sensitive(row.sensitive, engine: engine)
    }
}

// A meeting still to come today, under Upcoming meetings, as the desktop draws one: its glyph, its name, and a grey
// line with when it is and who else is on it
struct Meeting: View {
    let row: Row
    let engine: Engine
    let top: CGFloat
    let bottom: CGFloat
    @Environment(\.openURL) private var openURL

    var body: some View {
        let start = row.start.flatMap(Row.parse)?.formatted(.dateTime.hour().minute()) ?? ""
        RailRow(time: "", top: top, bottom: bottom) { Color.clear.frame(height: 1) } content: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                // a calendar, or a route for Travel (main/timeline.js meetingIcon)
                Image(row.icon == "pinRoute" ? "Glyphs/pinRoute" : "Glyphs/calendar").resizable().frame(width: 18, height: 18).foregroundStyle(.secondary)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
                VStack(alignment: .leading, spacing: 4) {
                    Text(engine.translator.words(row.words, sensitive: row.sensitive == true).0).sensitive(row.sensitive, engine: engine)
                    // the desktop's grey line: when (13:10–13:40), then who else is on it as faces
                    HStack(spacing: 6) {
                        Text(row.subtext ?? start).font(.subheadline).monospacedDigit().foregroundStyle(.secondary)
                        if let people = row.people, !people.isEmpty { Text("·").foregroundStyle(.secondary); Faces(people: people, names: false) }
                    }
                }
            }
        }
        .onTapGesture { openURL.zoom(row.id) }
        .nodeMenu(row.id, engine: engine)
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
    var names = true // false: the faces alone, as after a meeting's time

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
            if names {
                Text(people.count <= 2 ? people.map(\.name).joined(separator: ", ") : "\(people.count) people")
                    .font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
            }
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
        case "tlAccepted", "tlLater", "tlInbox", "tlNew", "updated", "robot", "tana", "free", "todayTasks", "pinRoute": icon!
        default: "calendar" // a meeting (the desktop draws its type's glyph, calendar)
        }
    }
}
