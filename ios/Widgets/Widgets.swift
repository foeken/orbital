import AppIntents
import Security
import SwiftUI
import WidgetKit

// The iPhone's widgets, as the Android app's (androidApp Widgets.kt): Today's Tasks across the widget's whole width, and
// the Timeline on its rail, a meeting's documents opened in place by its chevron. They draw what the app last read
// (Engine.swift keepGlimpse), left in the Keychain in Orbital's own access group as the Share extension leaves what it
// shares: a widget cannot run the engine. A row opens its node in the app (orbital:<id>, Shell.swift), + Quick Add.
@main
struct OrbitalWidgets: WidgetBundle {
    var body: some Widget {
        TodayWidget()
        TimelineWidget()
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

struct TimelineWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "Timeline", provider: Provider()) { RailTimeline(entry: $0) }
            .configurationDisplayName("Timeline")
            .description("Today's tasks, the meetings to come with their documents, and what happened")
            .supportedFamilies([.systemLarge])
    }
}

// What the app left, and which meetings this widget has opened (ShowDocuments)
struct Entry: TimelineEntry {
    let date: Date
    let glimpse: Glimpse?
    let open: Set<String>
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry { Entry(date: .now, glimpse: nil, open: []) }
    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) { completion(entry(.now, Glimpse.read())) }
    // drawn again as each meeting to come starts, so it leaves Upcoming meetings, and in half an hour anyway; the app has
    // it drawn again after every read (WidgetCenter)
    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        let glimpse = Glimpse.read(), now = Date.now
        let starts = glimpse?.upcoming(now).compactMap { $0.start.flatMap(Glimpse.parse) } ?? []
        completion(Timeline(entries: ([now] + starts).map { entry($0, glimpse) }, policy: .after(now.addingTimeInterval(1800))))
    }
    private func entry(_ date: Date, _ glimpse: Glimpse?) -> Entry {
        Entry(date: date, glimpse: glimpse, open: Set(UserDefaults.standard.stringArray(forKey: ShowDocuments.key) ?? []))
    }
}

// A meeting's chevron: its documents shown under it, or hidden again; kept by this extension, and WidgetKit draws again
struct ShowDocuments: AppIntent {
    static let title: LocalizedStringResource = "Show a meeting's documents"
    static let key = "open"
    @Parameter(title: "Meeting") var meeting: String

    init() {}
    init(meeting: String) { self.meeting = meeting }

    func perform() async throws -> some IntentResult {
        var open = Set(UserDefaults.standard.stringArray(forKey: Self.key) ?? [])
        if open.remove(meeting) == nil { open.insert(meeting) }
        UserDefaults.standard.set(Array(open), forKey: Self.key)
        return .result()
    }
}

// What the app keeps for the widgets (Engine.swift Glimpse, Glimpse.kt): only what is drawn here of each row
struct Glimpse: Decodable {
    let read: Double
    let rows: [Row]
    let docs: [String: [Row]]?

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

        struct Segment: Decodable { let text: String?; let mention: Mention? }
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
    private static let group = "6DA7MK99T2.com.dreetje.orbital"
    static func read() -> Glimpse? {
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: "com.dreetje.orbital", kSecAttrAccount: "glimpse",
                                      kSecAttrAccessGroup: group, kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Glimpse.self, from: data)
    }

    var today: [Row]? { rows.first { $0.timeline?.today == true }.map { $0.children ?? [] } }
    // drawn later than it was read: free time that has ended is gone, and a meeting that has started is no longer to come
    func free(_ now: Date) -> Date? {
        rows.compactMap(\.timeline?.free).first.map { Date(timeIntervalSince1970: $0.until / 1000) }.flatMap { $0 > now ? $0 : nil }
    }
    func upcoming(_ now: Date) -> [Row] {
        (rows.first { $0.timeline?.upcoming == true }?.children ?? []).filter { ($0.start.flatMap(Self.parse) ?? now) > now }
    }
    // what happened, under each day (Timeline.swift days): Today and Yesterday against this phone's date
    func days(_ now: Date) -> [(title: String, rows: [Row])] {
        var out: [(key: String, title: String, rows: [Row])] = []
        for row in rows where !row.top {
            let key = row.timeline?.day ?? ""
            if out.last?.key == key { out[out.count - 1].rows.append(row) } else { out.append((key, Self.day(key, row.timeline?.dayTitle, now), [row])) }
        }
        return out.map { ($0.title, $0.rows) }
    }
    private static func day(_ key: String, _ title: String?, _ now: Date) -> String {
        let format = Date.ISO8601FormatStyle(timeZone: .current).year().month().day()
        if key == now.formatted(format) { return "Today" }
        if let before = Calendar.current.date(byAdding: .day, value: -1, to: now), key == before.formatted(format) { return "Yesterday" }
        return title ?? key
    }
    static func parse(_ s: String) -> Date? {
        (try? Date(s, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true))) ?? (try? Date(s, strategy: .iso8601))
    }
    static func kind(_ uri: String?) -> String? { uri?.split(separator: ":").dropFirst().first.map(String.init) }
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
                    Link(destination: URL(string: "orbital:" + task.id)!) {
                        HStack(spacing: 10) { TaskBox(state: task.stateType); Words(row: task) }.frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .containerBackground(Color.page, for: .widget)
        .widgetURL(URL(string: "orbital:timeline")) // the small widget's tap, which has no links of its own
    }
}

// The Timeline as the app draws it (Timeline.swift): Now and Today's Tasks, the free time, Upcoming meetings, a line,
// then what happened under each day, the tasks an entry brought hanging under it, on one rail; as much as fits
struct RailTimeline: View {
    let entry: Entry

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Bar(title: "Timeline")
            if let glimpse = entry.glimpse {
                let stops = Self.stops(glimpse, entry.date, entry.open)
                if stops.isEmpty { Note(words: "Nothing yet. Changes to your tasks, new Inbox tasks and your meetings show up here.") }
                ForEach(stops.prefix(13)) { $0 }
            } else {
                Note(words: "Open Orbital to see your Timeline here.")
            }
            Spacer(minLength: 0)
        }
        .containerBackground(Color.page, for: .widget)
    }

    static func stops(_ g: Glimpse, _ now: Date, _ open: Set<String>) -> [Stop] {
        var out: [Stop] = []
        func rail(_ stop: Stop) { var stop = stop; stop.first = !out.contains { $0.heading == nil && !$0.line }; out.append(stop) }
        func link(_ id: String?) -> URL? { id.flatMap { URL(string: "orbital:" + $0) } }
        func tasks(_ list: [Glimpse.Row]) { for task in list { rail(Stop(task: task, opens: link(task.id))) } }
        func meeting(_ m: Glimpse.Row, label: String, mark: (String, String?)?, glyph: String?) {
            let id = m.timeline?.uri ?? m.id, docs = g.docs?[id] ?? []
            rail(Stop(label: label, mark: mark, row: m, glyph: glyph, quiet: m.timeline?.tone == "faint", opens: link(id), toggle: docs.isEmpty ? nil : id, opened: open.contains(id)))
            if open.contains(id) { for doc in docs { rail(Stop(row: doc, glyph: "doc", opens: link(doc.id))) } }
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
        let days = g.days(now)
        if !out.isEmpty, !days.isEmpty { out.append(Stop(line: true)) }
        for (title, entries) in days {
            out.append(Stop(heading: title))
            for e in entries {
                let mark = (Self.marker(e.icon), e.timeline?.recording == true ? "live" : e.timeline?.tone)
                if Glimpse.kind(e.timeline?.uri) == "event" { meeting(e, label: e.timeline?.time ?? "", mark: mark, glyph: nil) }
                else { rail(Stop(label: e.timeline?.time ?? "", mark: mark, row: e, quiet: e.timeline?.tone == "faint", opens: link(e.timeline?.uri))) }
                tasks(e.children ?? [])
            }
        }
        return out
    }

    // the rail's marker for a row's icon (main/timeline.js ICON, Timeline.swift Marker): a meeting by its calendar
    static func marker(_ icon: String?) -> String {
        switch icon {
        case "tlAccepted", "tlLater", "tlInbox", "tlNew", "updated", "robot", "tana", "free", "todayTasks", "pinRoute": icon ?? "calendar"
        default: "calendar"
        }
    }
}

// One stop on the rail, a day's heading, or the line under what is still to come: the time, the marker on a line through
// the markers' middle, what happened; a meeting with documents ends in its chevron
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
    var toggle: String? = nil // the meeting whose documents the chevron shows
    var opened = false

    var body: some View {
        if let heading {
            Text(heading).font(.subheadline.weight(.medium)).foregroundStyle(Color.grey).frame(height: 24).padding(.leading, 8)
        } else if line {
            Rectangle().fill(Color.rule).frame(height: 1).padding(.vertical, 6).padding(.leading, 8)
        } else {
            HStack(spacing: 0) {
                Link(destination: opens ?? URL(string: "orbital:timeline")!) {
                    HStack(spacing: 8) {
                        Text(label).font(.caption.monospacedDigit()).foregroundStyle(Color.grey).lineLimit(1).frame(width: 40, alignment: .trailing)
                        ZStack {
                            Rectangle().fill(Color.rule).frame(width: 1).padding(.top, first ? 12 : 0)
                            if let mark { Marker(glyph: mark.0, tone: mark.1) }
                        }.frame(width: 20)
                        content
                        Spacer(minLength: 0)
                    }
                }
                if let toggle {
                    Button(intent: ShowDocuments(meeting: toggle)) {
                        Image(systemName: opened ? "chevron.up" : "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(Color.grey).frame(width: 30, height: 24)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(opened ? "Hide documents" : "Show documents")
                }
            }
            .frame(height: 24)
        }
    }

    @ViewBuilder private var content: some View {
        if let task {
            HStack(spacing: 8) { TaskBox(state: task.stateType); Words(row: task) }
        } else if let row {
            HStack(spacing: 6) { if let glyph { GlyphImage(name: glyph, size: 14).foregroundStyle(Color.grey) }; Words(row: row, quiet: quiet) }
        } else if let words {
            Text(words).font(.subheadline).foregroundStyle(quiet ? Color.grey : Color.ink).lineLimit(1)
        }
    }
}

// the widget's bar: its title, and + for Quick Add
struct Bar: View {
    let title: String
    var body: some View {
        HStack {
            Text(title).font(.headline).foregroundStyle(Color.ink).lineLimit(1)
            Spacer()
            Link(destination: URL(string: "orbital:add")!) { Image(systemName: "plus").font(.body.weight(.medium)).foregroundStyle(Color.ink) }
                .accessibilityLabel("Quick Add Task")
        }
        .padding(.bottom, 6)
    }
}

struct Note: View {
    let words: String
    var body: some View { Text(words).font(.subheadline).foregroundStyle(Color.grey) }
}

// a row's words, a done task struck; a sensitive one a bar, as the app draws it until a shake (its words are never in
// what the app left)
struct Words: View {
    let row: Glimpse.Row
    var quiet = false
    var body: some View {
        if row.sensitive == true {
            RoundedRectangle(cornerRadius: 3).fill(Color.barred).frame(width: 64 + CGFloat(row.id.utf8.reduce(0) { $0 + Int($1) } % 56), height: 9).accessibilityLabel("Sensitive")
        } else {
            let done = row.stateType == "closed"
            Text(row.words).font(.subheadline).strikethrough(done).foregroundStyle(quiet || done ? Color.grey : Color.ink).lineLimit(1)
        }
    }
}

// the app's box (Timeline.swift CheckBox): grey, green with a tick once done, a dashed outline for an Inbox task
struct TaskBox: View {
    let state: String?
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 4.5, style: .continuous)
        ZStack {
            switch state {
            case "proposed": shape.strokeBorder(Color.pair(0xc8c8c8, 0x5d6467), style: StrokeStyle(lineWidth: 1.2, dash: [2.6, 2.4]))
            case "closed": shape.fill(Color.pair(0x6fae82, 0x5b976c)); GlyphImage(name: "applyDone", size: 10).foregroundStyle(.white)
            default: shape.fill(Color.pair(0xe4e4e4, 0x3a3e40))
            }
        }
        .frame(width: 16, height: 16)
    }
}

// finished work a green disc with a white check; a new task or a meeting with no write-up quieter; one being recorded blue
struct Marker: View {
    let glyph: String
    let tone: String?
    var body: some View {
        if tone == "done" {
            GlyphImage(name: "applyDone", size: 10).foregroundStyle(.white).frame(width: 18, height: 18).background(Circle().fill(Color.done))
        } else {
            GlyphImage(name: glyph, size: 16).foregroundStyle(tone == "live" ? Color.blue : tone == "new" || tone == "faint" ? Color.faint : Color.grey)
                .frame(width: 20, height: 20).background(Circle().fill(Color.page)) // the rail passes behind it
        }
    }
}

// the Nucleo glyphs the app draws (scripts/build-ios-glyphs.js), the few the widgets need in their own catalog
struct GlyphImage: View {
    let name: String
    let size: CGFloat
    var body: some View { Image("Glyphs/" + name).resizable().frame(width: size, height: size) }
}

// the app's colours, light and dark (Timeline.swift Color.pair, the desktop's styles.css)
extension Color {
    static func pair(_ light: UInt32, _ dark: UInt32) -> Color {
        let rgb = { (v: UInt32) in UIColor(red: CGFloat(v >> 16 & 0xff) / 255, green: CGFloat(v >> 8 & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1) }
        return Color(UIColor { $0.userInterfaceStyle == .dark ? rgb(dark) : rgb(light) })
    }
    static let page = pair(0xffffff, 0x1b1d1e)
    static let ink = pair(0x1a1a1a, 0xe3e4e5)
    static let grey = pair(0x666666, 0xa0a5a8)
    static let faint = pair(0xa3a3a8, 0x6b7073)
    static let rule = pair(0xe2e2e4, 0x34383a)
    static let done = Color(red: 0x5a / 255, green: 0x96 / 255, blue: 0x70 / 255)
    static let barred = pair(0x696d73, 0x8c9196).opacity(0.18)
}
