import Security
import SwiftUI
import WidgetKit

// The iPhone's widgets, as the Android app's (androidApp Widgets.kt): Today's Tasks across the widget's whole width, and
// the Timeline on its rail in two: what is ahead today (today's tasks and the meetings to come) and Activity, what
// happened. A widget does not scroll, so each draws as much as fits. They draw what the app last read
// (Engine.swift keepTimeline), left in the Keychain in Orbital's own access group as the Share extension leaves what it
// shares: a widget cannot run the engine. A row opens its node in the app (orbital:<id>, Shell.swift), + Quick Add.
// A task's box opens the app too (TickTaskIntent, Orbital's own: a link ticks nothing), which ticks it and writes it to
// Tana at once: this extension has no engine to write with. On the Lock Screen, Quick Add.
@main
struct OrbitalWidgets: WidgetBundle {
    var body: some Widget {
        TodayWidget()
        AheadWidget()
        ActivityWidget()
        QuickAddWidget()
    }
}

struct TodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "Today", provider: Provider()) { TodayTasks(entry: $0) }
            .configurationDisplayName("Today's Tasks")
            .description("The tasks pinned to today, each a tap from its page")
            .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

// the Timeline above its line: Now, today's tasks, the free time and the meetings to come
struct AheadWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "Ahead", provider: Provider()) { RailTimeline(entry: $0, part: .ahead) }
            .configurationDisplayName("Today's Tasks and Upcoming Meetings")
            .description("Today's tasks and the meetings to come, with their documents, on the Timeline's rail")
            .supportedFamilies([.systemMedium, .systemLarge])
    }
}

// the Timeline under its line: what happened, by day; nothing to add there, so no +
struct ActivityWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "Activity", provider: Provider()) { RailTimeline(entry: $0, part: .activity) }
            .configurationDisplayName("Activity")
            .description("What happened to your tasks and meetings, day by day")
            .supportedFamilies([.systemMedium, .systemLarge])
    }
}

// Quick Add on the Lock Screen: a round + that opens Quick Add in the app (orbital:add), as the widgets' + does. Android's
// lock screen takes no widgets of an app's own; its place there is a Quick Settings tile (QuickAddTile.kt).
struct QuickAddWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "QuickAdd", provider: Still()) { _ in QuickAddButton() }
            .configurationDisplayName("Quick Add")
            .description("A new task, straight from the Lock Screen")
            .supportedFamilies([.accessoryCircular])
    }
}

struct QuickAddButton: View {
    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            Image(systemName: "plus").font(.title2.weight(.semibold))
        }
        .widgetURL(URL(string: "orbital:add"))
        .containerBackground(.clear, for: .widget)
        .accessibilityLabel("Quick Add Task")
    }
}

// what never changes: drawn once
struct Still: TimelineProvider {
    func placeholder(in context: Context) -> Entry { Entry(date: .now, glimpse: nil) }
    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) { completion(placeholder(in: context)) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        completion(Timeline(entries: [placeholder(in: context)], policy: .never))
    }
}

// What the app left
struct Entry: TimelineEntry {
    let date: Date
    let glimpse: Glimpse?
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry { Entry(date: .now, glimpse: nil) }
    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) { completion(Entry(date: .now, glimpse: Glimpse.read())) }
    // drawn again as each meeting to come starts, so it leaves Upcoming meetings, and in half an hour anyway; the app has
    // it drawn again after every read (WidgetCenter)
    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        let glimpse = Glimpse.read(), now = Date.now
        let starts = glimpse?.upcoming(now).compactMap { $0.start.flatMap(Date.tana) } ?? []
        completion(Timeline(entries: ([now] + starts).map { Entry(date: $0, glimpse: glimpse) }, policy: .after(now.addingTimeInterval(1800))))
    }
}

// What the app keeps for the widgets (Engine.swift Glimpse, Glimpse.kt): only what is drawn here of each row
struct Glimpse: Decodable {
    let read: Double
    let rows: [Row]

    struct Row: Decodable {
        let id: String
        let text: String?
        let title: String?
        let segments: [Segment]?
        let icon: String?
        let stateType: String?
        let subtext: String?
        let start: String?
        let sensitive: Bool?
        let children: [Row]?
        let timeline: Info?

        struct Segment: Decodable { let text: String?; let mention: Mention?; let content: Bool?; let person: Bool? }
        struct Mention: Decodable { let label: String? }
        struct Free: Decodable { let until: Double }
        struct Info: Decodable {
            let uri: String?
            let tone: String?
            let today: Bool?
            let upcoming: Bool?
            let free: Free?
            let recording: Bool?
            let time: String?
            let day: String?
            let dayTitle: String?
        }

        var words: String {
            let said = (segments ?? []).map { $0.text ?? $0.mention?.label ?? "" }.joined()
            return said.isEmpty ? (title ?? text ?? "") : said
        }
        var top: Bool { timeline?.today == true || timeline?.upcoming == true || timeline?.free != nil }
    }

    // where the app leaves it: a Keychain item in Orbital's own access group (Widgets.entitlements, as Share.entitlements)
    static func read() -> Glimpse? { Keychain.load("glimpse", group: Keychain.group).flatMap { try? JSONDecoder().decode(Glimpse.self, from: $0) } }

    var today: [Row]? { rows.first { $0.timeline?.today == true }.map { $0.children ?? [] } }
    // drawn later than it was read: free time that has ended is gone, and a meeting that has started is no longer to come
    func free(_ now: Date) -> Date? {
        rows.compactMap(\.timeline?.free).first.map { Date(timeIntervalSince1970: $0.until / 1000) }.flatMap { $0 > now ? $0 : nil }
    }
    func upcoming(_ now: Date) -> [Row] {
        (rows.first { $0.timeline?.upcoming == true }?.children ?? []).filter { ($0.start.flatMap(Date.tana) ?? now) > now }
    }
    // what happened, under each day (Day.sections, as Timeline.swift draws them): Today and Yesterday against this phone's date
    func days(_ now: Date) -> [(title: String, rows: [Row])] {
        Day.sections(rows.filter { !$0.top }, now: now, key: { $0.timeline?.day }, title: { $0.timeline?.dayTitle })
    }
    // What happened, under each day, for the Activity widget, each task once: at the latest thing that happened to it
    // (the rows come newest first), so a task added and then completed is the completion alone. A line of tasks added
    // keeps the ones nothing happened to since, and goes when none is left; a day left empty goes too; a meeting is
    // always itself. With each line, the tasks it brought. Android's Glimpse.activity (GlimpseTest) is the same.
    func activity(_ now: Date) -> [(title: String, lines: [(row: Row, added: [Row])])] {
        var seen = Set<String>()
        return days(now).map { day in
            (day.title, day.rows.compactMap { e -> (row: Row, added: [Row])? in
                let added = e.children ?? []
                if Glyph.kind(of: e.timeline?.uri) == "event" { return (e, added) }
                if added.isEmpty { return e.timeline?.uri.map { seen.insert($0).inserted } == false ? nil : (e, added) }
                let fresh = added.filter { seen.insert($0.id).inserted }
                return fresh.isEmpty ? nil : (e, fresh)
            })
        }.filter { !$0.lines.isEmpty }
    }
}

// An Activity line about a task's state ("completed Plan the offsite"), drawn as the task itself: its box in the state
// the line left it in (the line's icon, main/timeline.js ICON) or a tick made since (Engine.keepTimeline keeps it on the
// line), and its title. Nil for any other line: an edit, a meeting.
// Android's Row.asTask (GlimpseTest) is the same.
extension Glimpse.Row {
    private static let stateOfIcon = ["apply": "closed", "tlAccepted": "open", "tlLater": "not_now", "tlInbox": "proposed"]
    func asTask() -> Glimpse.Row? {
        guard let uri = timeline?.uri, Glyph.kind(of: uri) == "text", let state = Self.stateOfIcon[icon ?? ""] else { return nil }
        return Glimpse.Row(id: uri, text: nil, title: segments?.last { $0.content == true }?.text ?? words, segments: nil, icon: nil, stateType: stateType ?? state,
                           subtext: nil, start: nil, sensitive: sensitive, children: nil, timeline: nil)
    }
}

// Today's Tasks, each a whole line: its box and its words; a tap opens the task
struct TodayTasks: View {
    let entry: Entry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        let tasks = entry.glimpse?.today ?? []
        VStack(alignment: .leading, spacing: 0) {
            Bar(title: "Today's Tasks")
            if entry.glimpse == nil { Note(words: "Open Orbital to see today's tasks here.") }
            else if tasks.isEmpty { Note(words: "Nothing pinned to today.") }
            else {
                ForEach(Array(tasks.prefix(family == .systemLarge ? 9 : 3).enumerated()), id: \.offset) { _, task in
                    HStack(spacing: 0) {
                        Tick(task: task, room: 10)
                        Link(destination: URL(string: "orbital:" + task.id)!) { Words(row: task).frame(maxWidth: .infinity, minHeight: 30, alignment: .leading) }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .containerBackground(Color.page, for: .widget)
        .widgetURL(URL(string: "orbital:timeline")) // the small widget's tap, which has no links of its own
    }
}

// The Timeline as the app draws it (Timeline.swift), in two widgets: Now and Today's Tasks, the free time and Upcoming
// meetings (ahead); or what happened under each day, the tasks an entry brought hanging under it (activity); on one
// rail, as much as fits
struct RailTimeline: View {
    enum Part { case ahead, activity }
    let entry: Entry
    let part: Part
    @Environment(\.widgetFamily) private var family

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Bar(title: part == .ahead ? "Today" : "Activity", plus: part == .ahead)
            if let glimpse = entry.glimpse {
                let stops = Self.stops(glimpse, entry.date, part)
                if stops.isEmpty { Note(words: part == .ahead ? "Nothing pinned to today, and no meetings to come." : "Nothing yet. Changes to your tasks, new Inbox tasks and your meetings show up here.") }
                ForEach(Self.fit(stops, family == .systemLarge ? 312 : 100)) { $0 }
            } else {
                Note(words: part == .ahead ? "Open Orbital to see today's tasks and meetings here." : "Open Orbital to see what happened here.")
            }
            Spacer(minLength: 0)
        }
        .containerBackground(Color.page, for: .widget)
        .widgetURL(URL(string: "orbital:timeline"))
    }

    static func stops(_ g: Glimpse, _ now: Date, _ part: Part) -> [Stop] {
        var out: [Stop] = []
        func rail(_ stop: Stop) { var stop = stop; stop.first = !out.contains { $0.heading == nil && !$0.line }; out.append(stop) }
        func link(_ id: String?) -> URL? { id.flatMap { URL(string: "orbital:" + $0) } }
        func tasks(_ list: [Glimpse.Row]) { for task in list { rail(Stop(task: task, opens: link(task.id))) } }
        func meeting(_ m: Glimpse.Row, label: String, mark: (String, String?)?, glyph: String?) {
            rail(Stop(label: label, mark: mark, row: m, glyph: glyph, quiet: m.timeline?.tone == "faint", opens: link(m.timeline?.uri ?? m.id)))
        }
        if part == .activity { // what happened, under each day, each task once (Glimpse.activity)
            for (title, entries) in g.activity(now) {
                out.append(Stop(heading: title))
                for (e, added) in entries {
                    let mark = (Glyph.marker(e.icon), e.timeline?.recording == true ? "live" : e.timeline?.tone)
                    let time = e.timeline?.time ?? ""
                    if Glyph.kind(of: e.timeline?.uri) == "event" { meeting(e, label: time, mark: mark, glyph: nil); tasks(added) }
                    else if let first = added.first {
                        // tasks added: the first on the time's line, its marker saying who added it, the rest under it
                        rail(Stop(label: time, mark: mark, task: first, opens: link(first.id)))
                        tasks(Array(added.dropFirst()))
                    } else if let task = e.asTask() {
                        // a task's state changed: the task itself, the marker says what happened
                        rail(Stop(label: time, mark: mark, task: task, opens: link(task.id)))
                    } else {
                        // anything else: its title, the marker says what (Words brief)
                        rail(Stop(label: time, mark: mark, row: e, quiet: e.timeline?.tone == "faint", opens: link(e.timeline?.uri), brief: true))
                    }
                }
            }
            return out
        }
        if let today = g.today {
            rail(Stop(label: "Now", mark: ("todayTasks", "new"), words: "Today's Tasks"))
            if today.isEmpty { rail(Stop(words: "Nothing pinned to today.", quiet: true)) } else { tasks(today) }
        }
        if let free = g.free(now) {
            rail(Stop(label: g.today == nil ? "Now" : "", mark: ("free", "new"), words: "No meetings until " + free.formatted(Date.FormatStyle(locale: Locale(identifier: "en_GB")).hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)), quiet: true))
        }
        let upcoming = g.upcoming(now)
        if !upcoming.isEmpty {
            rail(Stop(mark: ("calendar", nil), words: "Upcoming meetings"))
            for m in upcoming { meeting(m, label: m.subtext?.components(separatedBy: "–").first ?? "", mark: nil, glyph: m.icon == "pinRoute" ? "pinRoute" : "calendar") }
        }
        return out
    }

    // as many stops as fit the widget's height: a line 24, a day's heading 18, the line under what is to come 13
    static func fit(_ stops: [Stop], _ height: CGFloat) -> [Stop] {
        var used: CGFloat = 0
        return Array(stops.prefix { stop in used += stop.heading != nil ? 18 : stop.line ? 13 : 24; return used <= height })
    }

}

// One stop on the rail, a day's heading, or the line under what is still to come: the time, the marker on a line through
// the markers' middle, what happened
struct Stop: View, Identifiable {
    var id = UUID()
    var label = ""
    var heading: String? = nil
    var line = false
    var first = false // the line starts at the first marker, as the app's does
    var mark: (String, String?)? = nil // the marker's glyph and tone
    var task: Glimpse.Row? = nil // a task: its box and its words
    var row: Glimpse.Row? = nil // an entry, a meeting or a document: its words
    var glyph: String? = nil // a glyph before them: a meeting to come, a document
    var words: String? = nil // words of the widget's own: Today's Tasks, Upcoming meetings, the free time
    var quiet = false
    var opens: URL? = nil
    var brief = false // an Activity line: the node's title first (Words)
    @Environment(\.widgetRenderingMode) private var mode

    var body: some View {
        if let heading {
            // smaller than a line, so more of what happened fits
            Text(heading).font(.caption.weight(.semibold)).foregroundStyle(Paint.grey.on(mode)).frame(height: 18, alignment: .bottom).padding(.leading, 8)
        } else if line {
            Rectangle().fill(Paint.rule.on(mode)).frame(height: 1).padding(.vertical, 6).padding(.leading, 8)
        } else {
            let target = opens ?? URL(string: "orbital:timeline")!
            HStack(spacing: 0) {
                Link(destination: target) {
                    HStack(spacing: 8) {
                        Text(label).font(.caption.monospacedDigit()).foregroundStyle(Paint.grey.on(mode)).lineLimit(1).frame(width: 40, alignment: .trailing)
                        Rail(first: first, mark: mark)
                    }
                    .padding(.trailing, 8)
                }
                if let task { Tick(task: task, room: 8) }
                Link(destination: target) { HStack(spacing: 0) { content; Spacer(minLength: 0) } }
            }
            .frame(height: 24)
        }
    }

    @ViewBuilder private var content: some View {
        if let task {
            Words(row: task)
        } else if let row {
            HStack(spacing: 6) { if let glyph { GlyphImage(name: glyph, size: 14).foregroundStyle(Paint.grey.on(mode)) }; Words(row: row, quiet: quiet, brief: brief) }
        } else if let words {
            Text(words).font(.subheadline).foregroundStyle((quiet ? Paint.grey : Paint.ink).on(mode)).lineLimit(1)
        }
    }
}

// the rail through the markers' middle, left out where a marker sits: nothing is laid behind a marker to hide it, as on
// a tinted or clear Home Screen iOS draws everything in its one tint, and a disc in the page's colour came out solid
struct Rail: View {
    let first: Bool // the line starts at the first marker, as the app's does
    let mark: (String, String?)?
    @Environment(\.widgetRenderingMode) private var mode

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                Rectangle().frame(width: 1, height: mark == nil ? 12 : 2).opacity(first ? 0 : 1)
                Spacer(minLength: mark == nil ? 0 : 20)
                Rectangle().frame(width: 1, height: mark == nil ? 12 : 2)
            }
            .foregroundStyle(Paint.rule.on(mode))
            if let mark { Marker(glyph: mark.0, tone: mark.1) }
        }
        .frame(width: 20, height: 24)
    }
}

// a task's box: a tap opens the app, which writes it to Tana at once (TickTaskIntent, Orbital's own: no link another app
// could send ticks anything), by the app's own rule (Engine.toggle): an Inbox task is accepted and a done one ticked back
// on (open), any other ticked off (closed)
struct Tick: View {
    let task: Glimpse.Row
    let room: CGFloat // between the box and the words, part of what a finger can tap

    var body: some View {
        let state = task.stateType, opens = state == "closed" || state == "proposed"
        Button(intent: TickTaskIntent(id: task.id, to: opens ? "open" : "closed")) {
            TaskBox(state: task.stateType).frame(width: 16 + room, height: 30, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel((state == "closed" ? "Mark as not done" : state == "proposed" ? "Accept" : "Mark as done")
                            + (task.sensitive == true ? "" : ", " + task.words)) // never a sensitive one's words
    }
}

// the widget's bar: its title, and + for Quick Add
struct Bar: View {
    let title: String
    var plus = true
    @Environment(\.widgetRenderingMode) private var mode
    var body: some View {
        HStack {
            Text(title).font(.headline).foregroundStyle(Paint.ink.on(mode)).lineLimit(1)
            Spacer()
            if plus {
                Link(destination: URL(string: "orbital:add")!) { Image(systemName: "plus").font(.body.weight(.medium)).foregroundStyle(Paint.ink.on(mode)) }
                    .accessibilityLabel("Quick Add Task")
            }
        }
        .padding(.bottom, 6)
    }
}

struct Note: View {
    let words: String
    @Environment(\.widgetRenderingMode) private var mode
    var body: some View { Text(words).font(.subheadline).foregroundStyle(Paint.grey.on(mode)) }
}

// a row's words, a done task struck; a sensitive one a bar, as the app draws it until a shake (its words are never in
// what the app left)
struct Words: View {
    let row: Glimpse.Row
    var quiet = false
    // brief: an Activity line, its sentence (main/timeline.js "Sam edited Onboarding flow") cut to the node's title, as
    // the marker beside it says what happened. VoiceOver still reads the whole sentence.
    var brief = false
    @Environment(\.widgetRenderingMode) private var mode
    var body: some View {
        if row.sensitive == true {
            RoundedRectangle(cornerRadius: 3).fill(Color.barred).frame(width: 64 + CGFloat(row.id.utf8.reduce(0) { $0 + Int($1) } % 56), height: 9).accessibilityLabel("Sensitive")
        } else if brief, let title = row.segments?.last(where: { $0.content == true })?.text {
            Text(title).font(.subheadline).foregroundStyle((quiet ? Paint.grey : Paint.ink).on(mode)).lineLimit(1).accessibilityLabel(row.words)
        } else {
            let done = row.stateType == "closed"
            Text(row.words).font(.subheadline).strikethrough(done).foregroundStyle((quiet || done ? Paint.grey : Paint.ink).on(mode)).lineLimit(1)
        }
    }
}

// the app's box (Timeline.swift CheckBox): grey, green with a tick once done, a dashed outline for an Inbox task; drawn
// in outline on a tinted or clear Home Screen, where a filled box would be solid tint
struct TaskBox: View {
    let state: String?
    @Environment(\.widgetRenderingMode) private var mode
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 4.5, style: .continuous)
        ZStack {
            if mode == .fullColor {
                switch state {
                case "proposed": shape.strokeBorder(Color.pair(0xc8c8c8, 0x5d6467), style: StrokeStyle(lineWidth: 1.2, dash: [2.6, 2.4]))
                case "closed": shape.fill(Color.pair(0x6fae82, 0x5b976c)); GlyphImage(name: "applyDone", size: 10).foregroundStyle(.white)
                default: shape.fill(Color.pair(0xe4e4e4, 0x3a3e40))
                }
            } else {
                switch state {
                case "proposed": shape.strokeBorder(.tertiary, style: StrokeStyle(lineWidth: 1.2, dash: [2.6, 2.4]))
                case "closed": shape.strokeBorder(.secondary, lineWidth: 1.2); GlyphImage(name: "applyDone", size: 10).foregroundStyle(.primary)
                default: shape.strokeBorder(.secondary, lineWidth: 1.2)
                }
            }
        }
        .frame(width: 16, height: 16)
    }
}

// finished work a green disc with a white check (a ring round the check when tinted); a new task or a meeting with no
// write-up quieter; one being recorded blue
struct Marker: View {
    let glyph: String
    let tone: String?
    @Environment(\.widgetRenderingMode) private var mode
    var body: some View {
        if tone == "done", mode == .fullColor {
            GlyphImage(name: "applyDone", size: 10).foregroundStyle(.white).frame(width: 18, height: 18).background(Circle().fill(Color.done))
        } else if tone == "done" {
            GlyphImage(name: "applyDone", size: 10).foregroundStyle(.primary).frame(width: 18, height: 18).overlay(Circle().strokeBorder(.secondary, lineWidth: 1.2))
        } else {
            let paint = tone == "live" ? (mode == .fullColor ? AnyShapeStyle(Color.blue) : AnyShapeStyle(.primary)) : (tone == "new" || tone == "faint" ? Paint.faint : Paint.grey).on(mode)
            GlyphImage(name: glyph, size: 16).foregroundStyle(paint).frame(width: 20, height: 20)
        }
    }
}

// the app's colours where the widget is drawn in full colour; on a tinted or clear Home Screen iOS draws every colour in
// its one tint, so there the levels are the system's own, which it draws at their strengths
enum Paint {
    case ink, grey, faint, rule
    func on(_ mode: WidgetRenderingMode) -> AnyShapeStyle {
        if mode == .fullColor {
            let color: Color = switch self { case .ink: .ink; case .grey: .grey; case .faint: .faint; case .rule: .rule }
            return AnyShapeStyle(color)
        }
        switch self {
        case .ink: return AnyShapeStyle(.primary)
        case .grey: return AnyShapeStyle(.secondary)
        case .faint, .rule: return AnyShapeStyle(.tertiary)
        }
    }
}

// the Nucleo glyphs the app draws (scripts/build-ios-glyphs.js), the few the widgets need in their own catalog
struct GlyphImage: View {
    let name: String
    let size: CGFloat
    var body: some View { Image("Glyphs/" + name).resizable().frame(width: size, height: size) }
}

// the app's colours, light and dark (Color.pair, ios/Common; the desktop's styles.css)
extension Color {
    static let page = pair(0xffffff, 0x1b1d1e)
    static let ink = pair(0x1a1a1a, 0xe3e4e5)
    static let grey = pair(0x666666, 0xa0a5a8)
    static let faint = pair(0xa3a3a8, 0x6b7073)
    static let rule = pair(0xe2e2e4, 0x34383a)
    static let barred = pair(0x696d73, 0x8c9196).opacity(0.18)
}
