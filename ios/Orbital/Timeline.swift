import SwiftUI

// One row as the desktop renderer gets it: of the Timeline (main/timeline.js), a saved search or a meeting's documents
// (ios/engine/index.js listRow), an outline (sdk/content.js) or a chat (sdk/chat.js); only what this draws. Encoded again
// for the widgets (Engine.swift keepTimeline), with a sensitive row's words taken out.
struct Row: Codable, Identifiable {
    let id: String
    var text: String?
    var title: String?
    var segments: [Segment]?
    let icon: String?
    let createdAt: String?
    let unread: Bool?
    let done: Bool?
    var stateType: String?
    var subtext: String?
    let start: String?
    let join: String?
    var people: [Person]?
    let assignees: [String]? // a task's, in a saved search: who it is assigned to, for Assign to …
    var children: [Row]?
    var timeline: Info?
    var reference: Ref?
    let heading: Int?
    let block: String?
    let type: String?
    let meta: String?
    let note: Bool?
    let chat: Chat?
    let sensitive: Bool? // marked sensitive in Orbital: drawn blurred until a shake shows it (ios/engine/sensitive.js)
    let group: String? // the section a saved search files it under (ios/engine/arrange.js)
    let glyph: String? // a saved search's own icon, a PNG in base64 (ios/engine/index.js iconPng)

    // content: the node's own words in a sentence of the app's (main/timeline.js), person: a person's name; the widgets'
    // Activity draws a line from them, title first (ios/Widgets Brief)
    struct Segment: Codable { let text: String?; let marks: Marks?; let mention: Ref?; var content: Bool? = nil; var person: Bool? = nil }
    struct Marks: Codable { let bold: Bool?; let italic: Bool?; let strike: Bool?; let code: Bool?; let link: String? }
    struct Ref: Codable { let uri: String; var label: String? }
    struct Chat: Codable { let mine: Bool?; let status: Bool?; let streaming: Bool?; let author: String? }
    struct Person: Codable { let name: String }
    struct Free: Codable { let from: Double; let until: Double }
    struct Info: Codable {
        let uri: String?
        var note: String?
        var change: String?
        var detail: String?
        let tone: String?
        let today: Bool?
        let upcoming: Bool?
        let free: Free?
        let recording: Bool? // a meeting under way whose call is being recorded or transcribed (main/timeline.js)
        // an entry's time on the rail, the day it is under (YYYY-MM-DD) and that day in words, in the desktop's own
        // formatting (ios/engine/labels.js); the blocks above the days have a time of their own ('Now', '') and no day
        let time: String?
        let day: String?
        let dayTitle: String?
    }

    // above the days: Today's Tasks, the free time and Upcoming meetings (main/timeline.js pageOf)
    var top: Bool { timeline?.today == true || timeline?.upcoming == true || timeline?.free != nil }
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
    // task: the task's state, which offers Assign to … and, out of the Inbox, Move to Inbox; assignees: who has it, when known (a saved search's rows)
    func nodeMenu(_ id: String?, engine: Engine, task: String? = nil, assignees: [String]? = nil, then done: @escaping () async -> Void = {}) -> some View {
        contextMenu {
            if let id, id.hasPrefix("tana:") {
                if task != nil { Button("Assign to …", systemImage: "person.crop.circle") { engine.assigning = .init(id: id, current: assignees, then: done) } }
                if let task, task != "proposed" { Button("Move to Inbox", systemImage: "tray") { Task { await engine.moveToInbox(id); await done() } } }
                let pinned = engine.pinned.contains(id), secret = engine.sensitiveIds.contains(id)
                // pinned to any day: only taking the pin off
                Button(pinned ? "Remove Pin" : "Pin to Today", systemImage: pinned ? "pin.slash" : "pin") { Task { await engine.pin(id, !pinned); await done() } }
                Button(secret ? "Not Sensitive" : "Mark as Sensitive", systemImage: secret ? "eye" : "eye.slash") { Task { await engine.markSensitive(id, !secret); await done() } }
                Divider()
                Button("Delete", systemImage: "trash", role: .destructive) { Task { if await engine.remove(id) { await done() } } }
            }
        }
    }

    // What is sensitive, drawn as the desktop draws it, until a shake of the phone or Settings shows it (Engine.reveal)
    func sensitive(_ on: Bool?, engine: Engine) -> some View {
        modifier(Blur(hidden: on == true && !engine.reveal))
    }
}

// Faces read it: under a hidden mark a face's circle would still say someone is there
extension EnvironmentValues { @Entry var sensitiveHidden = false }

struct Blur: ViewModifier {
    let hidden: Bool
    func body(content: Content) -> some View {
        if hidden {
            content.textRenderer(Redacted()).environment(\.sensitiveHidden, true).accessibilityElement(children: .ignore).accessibilityLabel("Sensitive, shake or use Settings to show")
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
            if hasToday {
                // one stop on the rail, as the desktop's: Now, the Today glyph, its words, the tasks hanging under them; with none, a
                // line saying so, as the desktop keeps the block
                RailRow(time: "Now", railTop: 24, bottom: 0) { Marker(icon: "todayTasks", tone: "new", now: false) } content: { Text("Today's Tasks") }
                if today.isEmpty {
                    RailRow(time: "", top: 30, bottom: 16) { Color.clear.frame(height: 1) } content: { // as much room under it as over it (measured)
                        Text("Nothing pinned to today. Long-press a task to pin it.").font(.subheadline).foregroundStyle(.secondary)
                    }
                } else {
                    TaskLines(tasks: today, engine: engine)
                }
            }
            // as the desktop has it: the free time, then one stop for the meetings still to come, each hanging under it like
            // a task, its start time on its right (the rail's own time column says only Now)
            if let free { FreeLine(free: free, time: hasToday ? "" : "Now", bottom: upcoming.isEmpty ? 0 : 14) } // flush on the line under it, as the last meeting is
            if !upcoming.isEmpty {
                RailRow(time: "", top: 14, bottom: 0) { Marker(icon: "meeting", tone: nil, now: false) } content: { Text("Upcoming meetings") }
                // the last one as far from the line under it as the first is from the heading (measured)
                ForEach(Array(upcoming.enumerated()), id: \.element.id) { i, m in Meeting(row: m, engine: engine, top: i == 0 ? 28 : 14, bottom: 0) }
            }
            if !upcoming.isEmpty || free != nil {
                // a line across under what is still to come, before what has happened
                if !days.isEmpty {
                    Color(.separator).frame(maxWidth: .infinity).frame(height: 1) // a List row lays a Divider out upright
                        .padding(.top, 28).padding(.bottom, 19) // as far from what is above as from the day under it (measured)
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
                    // the saved Timeline is on screen before Tana connects, or when it cannot be reached: more days wait for
                    // it, greyed and saying why
                    Text(engine.loading || engine.phase == .starting ? "Loading…" : engine.phase == .ready ? "Show three more days" : "Can't reach Tana").frame(maxWidth: .infinity)
                }
                .foregroundStyle(.secondary)
                .disabled(engine.loading || engine.phase != .ready)
                .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 0) // a row as tall as its padding says: a short one was stretched to 44 pt and centred, so no margin was what it read
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
    private var hasToday: Bool { engine.rows.contains { $0.timeline?.today == true } }
    private var today: [Row] { engine.shown(engine.rows.first { $0.timeline?.today == true }?.children).filter { !engine.unpinned.contains($0.id) } }
    private var upcoming: [Row] { engine.shown(engine.rows.first { $0.timeline?.upcoming == true }?.children) }
    private var free: Row.Free? { engine.rows.first { $0.timeline?.free != nil }?.timeline?.free }

    // Today, Yesterday and each day before, by the day the engine put each row under (renderer/timeline.js
    // timelineGroups, ios/engine/labels.js)
    private var days: [(String, [Row])] {
        var out: [(key: String, title: String, rows: [Row])] = []
        for row in engine.shown(engine.rows) where !row.top {
            let key = row.timeline?.day ?? ""
            if out.last?.key == key { out[out.count - 1].rows.append(row) } else { out.append((key, Self.day(key, row.timeline?.dayTitle), [row])) }
        }
        return out.map { ($0.title, $0.rows) }
    }

    // A day's heading (renderer/timeline.js timelineDay): Today and Yesterday said here against this phone's date, so they
    // are right past midnight before the next read; any other day in the engine's words for it (Times.kt day)
    private static func day(_ key: String, _ title: String?) -> String {
        if key == Self.key(.now) { return "Today" }
        if let before = Calendar.current.date(byAdding: .day, value: -1, to: .now), key == Self.key(before) { return "Yesterday" }
        return title ?? key
    }
    // a day as the engine keys it: YYYY-MM-DD in this phone's time zone
    static func key(_ d: Date) -> String { d.formatted(Date.ISO8601FormatStyle(timeZone: .current).year().month().day()) }
}

// A section's heading: a row of its own between two stretches of rail, its words in the middle of the gap. Not a
// sticky List header, whose extra space above sat the words low and whose pinned band cut the top bar off.
struct Heading: View {
    let title: String
    var body: some View {
        Text(title).font(.headline).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 11).padding(.bottom, 17) // as far from the entry above as from the one under it (measured)
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
        RailRow(time: row.timeline?.time ?? "", bottom: engine.shown(row.children).isEmpty ? 14 : 0) { // the desktop's 24-hour time (ios/engine/labels.js)
            Marker(icon: row.icon, tone: row.tone, now: row.timeline?.recording == true)
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
        // spelt out and typed, each a statement of its own, so the chain below is quick to type-check
        let label: String = task.sensitive == true && !engine.reveal ? "Sensitive task" : task.words // hidden from VoiceOver as from the eye
        let value: String = state == "closed" ? "Completed" : state == "proposed" ? "In your Inbox" : "Not completed"
        let button = Button(action: tick) { Self.box(state) }.buttonStyle(.plain)
        button
        .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 4 } // centred on the first line, as the markers are
        .sensoryFeedback(.success, trigger: engine.states[task.id]) { _, now in now == "closed" } // your own tick, not a change read from Tana
        .animation(reduceMotion ? nil : .snappy, value: state)
        .accessibilityLabel(label)
        .accessibilityValue(value)
        .accessibilityHint("Ticks the task off, or back on")
        .taskEntity(task.id) // "check this off": Siri knows which (Intents.swift)
    }

    private func tick() { Task { await engine.toggle(task) } }
    // a finger-sized target around a text-sized box
    private static func box(_ state: String) -> some View { CheckBox(state: state).padding(10).contentShape(Rectangle()).padding(-10) }
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
            TaskLine(task: task, engine: engine, top: i == 0 ? 30 : 16, bottom: i == tasks.count - 1 ? 16 : 0)
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
        .nodeMenu(task.id, engine: engine, task: engine.state(of: task), assignees: task.assignees)
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

// A task's words, struck and grey once done; in the chosen language when they are in another (the translate glyph says so, after
// them, or on the row's grey line where it has one: globe false)
struct TaskWords: View {
    let row: Row
    let engine: Engine
    var globe = true
    var body: some View {
        let done = engine.state(of: row) == "closed", (words, from) = engine.translator.words(row.words, sensitive: row.sensitive == true)
        (Text(words) + Text(from == nil || !globe ? "" : "  \(Image("Glyphs/language"))").font(.footnote).foregroundStyle(.tertiary))
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
        RailRow(time: "", top: top, bottom: bottom) { Color.clear.frame(height: 1) } content: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                // a calendar, or a route for Travel (main/timeline.js meetingIcon)
                Image(row.icon == "pinRoute" ? "Glyphs/pinRoute" : "Glyphs/calendar").resizable().frame(width: 18, height: 18).foregroundStyle(.secondary)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
                VStack(alignment: .leading, spacing: 4) {
                    Text(engine.translator.words(row.words, sensitive: row.sensitive == true).0).sensitive(row.sensitive, engine: engine)
                    // the desktop's grey line: when (13:10–13:40, or its start when it has no end: ios/engine/labels.js),
                    // then who else is on it as faces
                    HStack(spacing: 6) {
                        Text(row.subtext ?? "").font(.subheadline).monospacedDigit().foregroundStyle(.secondary)
                        if let people = row.people, !people.isEmpty { Text("·").foregroundStyle(.secondary); Faces(people: people, names: false) }
                    }
                    .sensitive(row.sensitive, engine: engine) // the grey line too, as the desktop's .sensitive .meta
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
    var bottom: CGFloat = 14

    var body: some View {
        RailRow(time: time, bottom: bottom) { Marker(icon: "free", tone: "new", now: false) } content: {
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
    @Environment(\.sensitiveHidden) private var hidden // under a sensitive mark: the names barred, no circles

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: -4) {
                ForEach(hidden ? [] : Array(people.prefix(4)), id: \.name) { p in
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
                    // the rail passes behind the glyph, as on the desktop; a recording meeting's ring pulses out between the two
                    .background { ZStack { Circle().fill(Color(.systemBackground)).padding(-2); if now { Pulse() } } }
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

// The desktop's recording ring (styles.css .tl-recording, rec-pulse): blue, swelling from behind the marker and fading,
// every 1.4 s; under Reduce Motion a still blue disc
struct Pulse: View {
    @Environment(\.accessibilityReduceMotion) private var still
    @State private var out = false
    var body: some View {
        Circle().fill(Color.blue)
            .opacity(still ? 0.25 : out ? 0 : 0.45)
            .scaleEffect(out && !still ? 2.2 : 1)
            .onAppear { if !still { withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) { out = true } } }
    }
}
