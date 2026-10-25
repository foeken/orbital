import SwiftUI

// One node in a list: a task's box or its kind's glyph, then its words and when it last changed as the button that opens
// it. The box is its own button beside it, so ticking a task never opens it too (TaskLine has them the same way).
struct ListRow: View {
    let row: Row
    let engine: Engine
    var reload: () async -> Void = {}
    @Environment(\.openURL) private var openURL

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            if row.stateType != nil {
                TaskBox(task: row, engine: engine)
            } else {
                Image("Glyphs/" + Glyph.of(row.icon)).resizable().frame(width: 20, height: 20).foregroundStyle(.secondary)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 4 }
            }
            Button { openURL.zoom(row.target) } label: {
                VStack(alignment: .leading, spacing: 3) {
                    let (words, from) = engine.translator.words(row.words, sensitive: row.sensitive == true)
                    if row.stateType != nil { TaskWords(row: row, engine: engine, globe: false) } else { Text(words).sensitive(row.sensitive, engine: engine) }
                    // when, then who a task is assigned to, on one grey line as the desktop's subtext has them
                    // translated, when it changed, who has it: one grey line as the desktop's subtext, a bullet between each
                    let at = row.createdAt.flatMap(Date.tana), people = row.people ?? []
                    HStack(spacing: 6) {
                        if from != nil { Image("Glyphs/language").resizable().frame(width: 15, height: 15).foregroundStyle(.secondary).accessibilityLabel("Translated from " + (from ?? "")) }
                        if from != nil, at != nil { Text("·").foregroundStyle(.secondary) }
                        if let at { Text(at, format: .relative(presentation: .named)).foregroundStyle(.secondary).lineLimit(1) }
                        if from != nil || at != nil, !people.isEmpty { Text("·").foregroundStyle(.secondary) }
                        if !people.isEmpty { Faces(people: people) }
                    }
                    .font(.subheadline)
                    .sensitive(row.sensitive, engine: engine) // when, who: barred with the words, as the desktop's .sensitive .meta
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 6)
        .nodeMenu(row.target, engine: engine, task: row.stateType != nil ? engine.state(of: row) : nil, assignees: row.assignees, then: reload)
    }
}

// A node opened from outside the app (an orbital: link: Echo's, another app's, a widget's, Siri's Open): a sheet over
// wherever you were, with a stack of its own, so a mention in it opens in the sheet and closing it leaves your place as
// it was. The page is NodeScreen, live as anywhere else. Android's Viewer (Pages.kt) the same.
struct Viewed: Identifiable { let id: String }
struct Viewer: View {
    let engine: Engine
    let id: String
    @State private var path: [String] = []
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack(path: $path) {
            NodeScreen(engine: engine, id: id)
                .toolbar { ToolbarItem(placement: .topBarLeading) { Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close") } }
                .navigationDestination(for: String.self) { NodeScreen(engine: engine, id: $0) }
        }
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme == "orbital" else { return .systemAction }
            path.append(String(url.absoluteString.dropFirst("orbital:".count)))
            return .handled
        })
        .modifier(EngineSheets(engine: engine))
    }
}

// What the engine asks to show (Assign to …, a pin menu's Pick a Date …, Assign to your Dot, Grant access), from the view
// on top: the shell, or the viewer over it, since a view that is presenting a sheet presents nothing else
struct EngineSheets: ViewModifier {
    let engine: Engine
    var on = true
    func body(content: Content) -> some View {
        content
            .sheet(item: Binding { on ? engine.assigning : nil } set: { engine.assigning = $0 }) { AssignSheet(engine: engine, task: $0) }
            .sheet(item: Binding { on ? engine.pickingDay : nil } set: { engine.pickingDay = $0 }) { PinDaySheet(engine: engine, picking: $0) }
            .sheet(item: Binding { on ? engine.handing : nil } set: { engine.handing = $0 }) { HandSheet(engine: engine, handing: $0) } // Agents.swift
            .shareAsk(engine, on: on)
    }
}

// Zoomed into a node: a saved search as its results, a meeting as its attendees and your notes or its summary, anything
// else as its outline; a chat stays on the Mac. Read-only; a mention, a reference or a row opens the node it names.
struct NodeScreen: View {
    let engine: Engine
    let id: String
    var titled = true // false when the page is the menu's own and the shell names it

    @State private var page: Engine.Page?
    @State private var error: String?
    @State private var access: Engine.Access? // a document's Assigned to and Visible to (NodeDetails)
    private var chat: Bool { Glyph.kind(of: id) == "chat" } // never read: a chat can be megabytes

    var body: some View {
        Group {
            if chat {
                ContentUnavailableView { Label { Text("Chats are on the Mac") } icon: { Image("Glyphs/discuss").resizable().frame(width: 48, height: 48) } } description: { Text("Open this chat in Orbital on your Mac.") }
            // a node you marked sensitive: what it is, and how to see it, until a shake shows it (the title says Hidden, as the desktop's tab does)
            } else if let page, page.sensitive == true, !engine.reveal {
                ContentUnavailableView { Label { Text("Hidden") } icon: { Image("Glyphs/hidden").resizable().frame(width: 48, height: 48) } } description: { Text("You marked this sensitive in Orbital. Shake your iPhone or turn on Show sensitive items in Settings to see it, and do the same again to hide it.") }
            } else if let page {
                switch page.kind {
                case "event":
                    MeetingPage(page: page, engine: engine)
                        .refreshable { await load() }
                case "search":
                    // in the sections the search was saved with (Row.group), as the desktop shows it: no lines between the
                    // rows or around a section, and the rows close together, closer still under headings, as the Timeline's
                    let sections = Self.sections(engine.shown(page.rows)), grouped = sections.contains { $0.title != nil }
                    List(Array(sections.enumerated()), id: \.offset) { _, section in
                        Section {
                            ForEach(section.rows) {
                                ListRow(row: $0, engine: engine, reload: load)
                                    .listRowSeparator(.hidden)
                                    .listRowInsets(EdgeInsets(top: grouped ? 1 : 3, leading: 20, bottom: grouped ? 1 : 3, trailing: 16))
                            }
                        } header: {
                            // in line with the rows: left to the system, a heading touched the Duo's column edge
                            if let title = section.title { Text(title).font(.headline).foregroundStyle(.secondary).textCase(nil).listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 16)) }
                        }
                        .listSectionSeparator(.hidden)
                    }
                        .listStyle(.plain)
                        .environment(\.defaultMinListRowHeight, 0) // the rows as tall as their words, not the system's 44
                        .refreshable { await load() }
                        .overlay { if page.rows.isEmpty { ContentUnavailableView("Nothing found", image: "Glyphs/" + Glyph.of(page.kind)) } }
                default:
                    List {
                        if let access { NodeDetails(id: id, access: access, engine: engine, reload: load) }
                        let flat = Self.flat(page.rows)
                        ForEach(Array(flat.enumerated()), id: \.offset) { i, e in
                            OutlineRow(row: e.row, depth: e.depth, number: e.number, above: Self.gap(e.row, after: i > 0 ? flat[i - 1].row : nil), reveal: engine.reveal, engine: engine)
                        }
                    }
                        .listStyle(.plain)
                        .environment(\.defaultMinListRowHeight, 0) // blocks as close as a document's, not the system's 44
                        .refreshable { await load() }
                        .overlay { if Self.flat(page.rows).isEmpty, access == nil { ContentUnavailableView("Nothing in here yet", image: "Glyphs/doc") } } // a document with fields shows them alone
                }
            } else if let error {
                ContentUnavailableView {
                    Label("Didn't open", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try again") { Task { await load() } }
                }
            } else {
                ProgressView()
            }
        }
        .onChange(of: engine.sensitiveIds) { Task { await load() } } // marked or unmarked on another device: drawn again
        // Demo mode turned on or off with this page open: read again, and none of the words read before it shown meanwhile
        .onChange(of: engine.demo) { page = nil; Task { await load() } }
        // untitled: no title at all, so the page around it keeps its own (the Timeline's tasks column)
        .modifier(Titled(title: !titled ? nil : page?.sensitive == true && !engine.reveal ? "" : engine.translator.words(page?.title ?? "", sensitive: page?.sensitive == true).0))
        // a document's pins: the days it is pinned to under its title, and the pin menu at the top right (PinChoices)
        .navigationSubtitle(access == nil ? "" : Phrases.pinnedTo(engine.pinDays(id), today: PinChoices.today, tomorrow: PinChoices.tomorrow) ?? "")
        .toolbar {
            if access != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    let ahead = Phrases.pinnedTo(engine.pinDays(id), today: PinChoices.today, tomorrow: PinChoices.tomorrow)
                    Menu { PinChoices(id: id, engine: engine, then: load) } label: {
                        // in the text colour while pinned from today on, quiet otherwise; the line under the title says to when
                        Image("Glyphs/pinDate").resizable().frame(width: 20, height: 20).foregroundStyle(ahead == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                    }
                    .accessibilityLabel("Pin").accessibilityValue(ahead ?? "Not pinned")
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .task(id: engine.phase) {
            guard engine.phase == .ready else { return }
            await load()
        }
        // Changed in Tana, by anyone anywhere (ios/engine/live.js): read again, as the desktop's page on screen is. A
        // saved search or a meeting takes a row added, changed or gone.
        .onChange(of: engine.changes[id]) { Task { await load() } }
    }

    // A read keeps what is on screen when it fails, and says why only while there is nothing to show
    private func load() async {
        guard !chat else { return }
        do { page = try await engine.open(id); error = nil } catch { self.error = error.localizedDescription }
        if let kind = page?.kind, !["search", "event"].contains(kind) { access = await engine.access(id) ?? access }
    }

    // consecutive rows under one heading; one untitled section when the search is not grouped
    static func sections(_ rows: [Row]) -> [(title: String?, rows: [Row])] {
        rows.reduce(into: []) { out, row in
            if let last = out.last, last.title == row.group { out[out.count - 1].rows.append(row) } else { out.append((row.group, [row])) }
        }
    }

    // the outline flattened, each row with how deep it sits and, in a numbered list, its number: nothing folds on the
    // phone, everything shows. shortcut: a list counts from 1 (sdk/content.js start is not read), as most do
    static func flat(_ rows: [Row], depth: Int = 0) -> [(row: Row, depth: Int, number: Int?)] {
        var n = 0
        return rows.filter { !$0.blank }.flatMap { row -> [(row: Row, depth: Int, number: Int?)] in
            n = row.block == "numbered" ? n + 1 : 0
            return [(row, depth, row.block == "numbered" ? n : nil)] + flat(row.children ?? [], depth: depth + 1)
        }
    }

    // The space above a block, as a reading document spaces them (a mockup of this page, 2026-10-25): a heading, or a
    // line wholly in bold, opens a section and sits close to what it heads; list items sit closer than paragraphs.
    // Android's Lists.gap the same.
    static func gap(_ row: Row, after prev: Row?) -> CGFloat {
        guard let prev else { return 8 }
        let k = kind(row), p = kind(prev)
        if k == "heading" { return p == "heading" ? 12 : 22 }
        if p == "heading" { return 6 }
        if k == "list" && p == "list" { return 6 }
        return k == "list" || p == "list" ? 9 : 12
    }
    private static func kind(_ r: Row) -> String {
        let words = (r.segments ?? []).filter { !($0.text ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
        if r.heading != nil || (!words.isEmpty && words.allSatisfy { $0.marks?.bold == true }) { return "heading" }
        return r.block == "bullet" || r.block == "numbered" ? "list" : "paragraph"
    }
}

private struct Titled: ViewModifier {
    let title: String?
    func body(content: Content) -> some View {
        if let title { content.navigationTitle(title) } else { content }
    }
}

// A meeting, as the desktop's page has it (renderer/meetingnotes.js, renderer/fields.js attendeesFieldEl): its attendees,
// A node's pin menu: today, tomorrow and each later day it is pinned to, ticked where it is (Phrases.pinChoices), then
// Pick a Date … and Remove All Pins. The pin button at the top of its page and the long press's Pin to … both show it.
struct PinChoices: View {
    let id: String
    let engine: Engine
    var then: () async -> Void = {}
    static var today: String { Day.key(.now) }
    static var tomorrow: String { Day.key(Calendar.current.date(byAdding: .day, value: 1, to: .now) ?? .now) }

    var body: some View {
        let days = engine.pinDays(id), today = Self.today, tomorrow = Self.tomorrow
        ForEach(Phrases.pinChoices(days, today: today, tomorrow: tomorrow), id: \.day) { c in
            Toggle(Phrases.pinDay(c.day, today: today, tomorrow: tomorrow), isOn: Binding(get: { c.on }, set: { on in Task { await engine.pinDay(id, c.day, on); await then() } }))
        }
        Divider()
        Button("Pick a Date …", systemImage: "calendar") { engine.pickingDay = .init(id: id, then: then) }
        if !days.isEmpty {
            Divider()
            Button("Remove All Pins", systemImage: "pin.slash", role: .destructive) { Task { await engine.pin(id, false); await then() } }
        }
    }
}

// Pick a Date …: a day from today on, pinned with Pin (Engine.pinDay); laid over everything by Shell
struct PinDaySheet: View {
    let engine: Engine
    let picking: Engine.PickingDay
    @State private var date = Calendar.current.date(byAdding: .day, value: 2, to: .now) ?? .now
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            DatePicker("Day", selection: $date, in: Calendar.current.startOfDay(for: .now)..., displayedComponents: .date)
                .datePickerStyle(.graphical)
                .padding(.horizontal)
                .navigationTitle("Pin to a Day")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Pin") { let day = Day.key(date); dismiss(); Task { await engine.pinDay(picking.id, day, true); await picking.then() } }
                    }
                }
        }
        .presentationDetents([.medium, .large])
    }
}

// A meeting, as the desktop's page has it (renderer/meetingnotes.js, renderer/fields.js attendeesFieldEl): its attendees,
// five and "And n more" past that, then your notes; once Tana wrote it up its summary, and Notes | Summary over it when you
// have notes too. Read only, as every page here.
struct MeetingPage: View {
    let page: Engine.Page
    let engine: Engine
    @State private var showNotes = false
    @State private var everyone = false

    var body: some View {
        let people = page.attendees ?? [], shown = everyone ? people : Array(people.prefix(5))
        let rows = page.summary.map { showNotes ? page.notes ?? [] : $0 } ?? page.notes ?? []
        List {
            if !people.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text("Attendees").foregroundStyle(.secondary).frame(width: 100, alignment: .leading)
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(shown.enumerated()), id: \.offset) { Text($0.element.name) }
                        if shown.count < people.count {
                            Button("And \(people.count - shown.count) more") { everyone = true }.buttonStyle(.plain).foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .modifier(FieldLine())
            }
            if page.summary != nil, page.notes != nil {
                Picker("Notes or summary", selection: $showNotes) { Text("Notes").tag(true); Text("Summary").tag(false) }
                    .pickerStyle(.segmented)
                    .listRowSeparator(.hidden)
            }
            let flat = NodeScreen.flat(rows)
            ForEach(Array(flat.enumerated()), id: \.offset) { i, e in
                OutlineRow(row: e.row, depth: e.depth, number: e.number, above: NodeScreen.gap(e.row, after: i > 0 ? flat[i - 1].row : nil), reveal: engine.reveal, engine: engine)
            }
            if NodeScreen.flat(rows).isEmpty {
                Text("No notes yet").foregroundStyle(.secondary).listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 0)
    }
}

// An image in an outline (Engine.image): the word Image until its picture has come, then the picture, the row's width;
// under a sensitive mark the word stays (Blur bars text only, so a picture would show through)
struct OutlineImage: View {
    let uri: String
    let engine: Engine
    @State private var image: UIImage?
    @Environment(\.sensitiveHidden) private var hidden

    var body: some View {
        Group {
            if let image, !hidden { Image(uiImage: image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 8)).accessibilityLabel("Image") }
            else { Text("Image").foregroundStyle(.secondary) }
        }
        .task(id: uri) { image = await engine.image(uri) }
    }
}

// An empty line with nothing under it, which a new task's content often is only: left out, so it draws no lone bullet
extension Row {
    var blank: Bool { words.trimmingCharacters(in: .whitespaces).isEmpty && (segments ?? []).isEmpty && type == nil && (children ?? []).isEmpty }
}

// One block of an outline: a bullet and its words, indented by depth; a heading bigger and with no bullet; a reference
// its node's glyph and name, which opens it
struct OutlineRow: View {
    let row: Row
    let depth: Int
    var number: Int? // its place in a numbered list (NodeScreen.flat)
    var above: CGFloat = 8 // the space over it (NodeScreen.gap)
    var reveal = false
    var engine: Engine? // to fetch an image row's picture
    @Environment(\.openURL) private var openURL

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) { // a marker only where Tana draws one: a paragraph has none
            if row.heading == nil {
                if let ref = row.reference {
                    Image("Glyphs/" + Glyph.of(uri: ref.uri)).resizable().frame(width: 18, height: 18).foregroundStyle(.secondary)
                        .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3.5 }
                } else if let number {
                    Text("\(number).").monospacedDigit().foregroundStyle(.secondary).frame(minWidth: 18, alignment: .trailing)
                } else if row.block == "bullet" {
                    Circle().fill(.tertiary).frame(width: 6, height: 6).frame(width: 18)
                        .alignmentGuide(.firstTextBaseline) { $0[.bottom] + 2.5 } // centred on the lower-case letters
                }
            }
            Group {
                if row.type == "image", let uri = row.image?.uri, let engine { OutlineImage(uri: uri, engine: engine) }
                else if row.type == "image" || row.type == "table" { Text(row.type == "image" ? "Image" : "Table").foregroundStyle(.secondary) }
                else { Text(row.styled) }
            }
            // a third heading and below smaller than the words under it, bold, as Tana draws it: a bold line stays body size
            .font(row.heading == 1 ? .title2.bold() : row.heading == 2 ? .title3.bold() : row.heading != nil ? .subheadline.bold() : .body)
            .frame(maxWidth: .infinity, alignment: .leading)
            .modifier(Blur(hidden: row.sensitive == true && !reveal))
        }
        .padding(.leading, CGFloat(depth) * 22)
        .padding(.top, above)
        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 16))
        .listRowSeparator(.hidden)
        .contentShape(Rectangle())
        .onTapGesture { openURL.zoom(row.reference?.uri) }
        .accessibilityAddTraits(row.reference != nil ? .isButton : [])
        .accessibilityAction { openURL.zoom(row.reference?.uri) }
    }
}

// Zoomed into a document: who has it and who can see it, as the desktop's Assigned to and Visible to fields
// (renderer/fields.js); a tap changes either, and someone assigned who cannot open it is named, with Grant access where
// the document's own list is its audience (renderer/access.js hiddenFromFix)
struct NodeDetails: View {
    let id: String
    let access: Engine.Access
    let engine: Engine
    let reload: () async -> Void
    @State private var picking = false

    var body: some View {
        if access.task {
            // Status: Tana's own four, as the desktop's Status pill offers them (renderer/pills.js); set outright (engine.tick)
            let now = engine.states[id] ?? access.state ?? "open"
            Menu {
                ForEach(Phrases.states, id: \.0) { state in
                    Button { Task { await engine.tick(id, to: state.0); await reload() } } label: {
                        if state.0 == now { Label(state.1, systemImage: "checkmark") } else { Text(state.1) }
                    }
                }
            } label: {
                line("Status") { Text(Phrases.state(now)).foregroundStyle(.primary) }
            }
            .buttonStyle(.plain)
            .modifier(FieldLine())
            field("Assigned to") { engine.assigning = .init(id: id, current: access.assignees.map(\.id), then: reload) } value: {
                if access.assignees.isEmpty { Text("Unassigned").foregroundStyle(.secondary) } else { Faces(people: access.assignees.persons) }
            }
        }
        field("Visible to") { picking = true } value: {
            if access.audience == "people", !access.people.isEmpty { Faces(people: access.people.persons) } else { Engine.Access.label(access.audience, access.space) }
        }
        .sheet(isPresented: $picking) { VisibilitySheet(id: id, access: access, engine: engine, done: reload) }
        // its pins are the pin menu in the top bar (NodeScreen, PinChoices); an outside pin: link opens the node there
        // handed to your Dot (Agents.swift): its name and its last Agent status line; a tap asks it again or takes it back
        if let held = access.agent {
            Menu {
                if let a = engine.agents.first(where: { $0.id == held.id }) { Button("Ask \(a.name) again …") { engine.handing = .init(id: id, agent: a, then: reload) } }
                Button("Unassign", role: .destructive) { Task { await engine.unhand(id); await reload() } }
            } label: {
                line("Agent") { Label { Text(held.name + " · " + held.word) } icon: { Image("Glyphs/robot").resizable().frame(width: 18, height: 18) }.foregroundStyle(.primary) }
            }
            .buttonStyle(.plain)
            .modifier(FieldLine())
        }
        if !access.hidden.isEmpty {
            HStack {
                Label("Not visible to " + access.hidden.names, systemImage: "exclamationmark.triangle").font(.subheadline).foregroundStyle(.orange)
                Spacer()
                if access.grants {
                    Button("Grant access") { Task { await engine.share(id, "people", access.participants + access.hidden.map(\.id)); await reload() } }
                        .buttonStyle(.bordered).controlSize(.small).tint(.primary)
                }
            }
            .modifier(FieldLine())
        }
    }


    // a field as the desktop draws one: its name in grey, its value after it, a line under it, the whole row the button
    // that changes it
    private func field(_ name: String, _ change: @escaping () -> Void, @ViewBuilder value: () -> some View) -> some View {
        Button(action: change) { line(name, value: value) }
        .buttonStyle(.plain)
        .modifier(FieldLine())
    }
    // its name in grey and its value after it, the whole width a target: a field's button, or a menu's label (Status, Agent)
    private func line(_ name: String, @ViewBuilder value: () -> some View) -> some View {
        HStack(spacing: 12) {
            Text(name).foregroundStyle(.secondary).frame(width: 100, alignment: .leading)
            value()
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }
}

// the line under a field, from its left edge to the right, and none above the first
struct FieldLine: ViewModifier {
    func body(content: Content) -> some View {
        content.listRowSeparator(.hidden, edges: .top).listRowSeparator(.visible, edges: .bottom).alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
    }
}

extension Engine.Access {
    // renderer/tasks.js AUDIENCES: the scope's glyph and its word, a space by its name; the glyph close to its word, as
    // Android's AudienceLabel draws it (a Label in a List row puts its glyph in the list's icon column, far from the
    // word, #753), and read by VoiceOver as the word alone
    static func label(_ scope: String, _ space: String?, glyphs: Bool = true) -> some View {
        let (word, glyph) = Phrases.audience(scope, space)
        return HStack(spacing: 6) {
            if glyphs { Image("Glyphs/" + glyph).resizable().frame(width: 18, height: 18).accessibilityHidden(true) }
            Text(word)
        }
        .foregroundStyle(.secondary)
    }
}

extension [Engine.Member] {
    var persons: [Row.Person] { map { Row.Person(name: $0.name) } }
    // "Kor", "Kor and Stan", "Kor, Stan and Jeroen" (renderer/access.js namesOf)
    var names: String { count > 1 ? dropLast().map(\.name).joined(separator: ", ") + " and " + last!.name : first?.name ?? "" }
}

// Who can see a document (renderer/access.js visibilityRows): only you, the people picked, or whoever sees where it lives,
// the rule it is shared by now ticked, who that is listed, and why not when you may not change it
struct VisibilitySheet: View {
    let id: String
    let access: Engine.Access
    let engine: Engine
    let done: () async -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if access.rules.contains("me") { choice("me", "Only me", "lock") }
                    if access.rules.contains("people") {
                        NavigationLink { PeoplePicker(access: access, engine: engine) { uris in dismiss(); Task { await engine.share(id, "people", uris); await done() } } } label: {
                            row("Selected people …", "userLock", on: access.rule == "people")
                        }
                    }
                    if access.rules.contains("inherit") { choice("inherit", "Inherit", "houseLock", detail: access.inherit) }
                } footer: { if let reason = access.reason { Text(reason) } }
                if !access.people.isEmpty {
                    Section("Who can see it") { ForEach(access.people) { Text($0.name) } }
                }
            }
            .tint(.primary)
            .navigationTitle("Visibility")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func choice(_ rule: String, _ title: String, _ glyph: String, detail: Engine.Audience? = nil) -> some View {
        Button { dismiss(); Task { await engine.share(id, rule, token: access.token); await done() } } label: {
            row(title, glyph, on: access.rule == rule, detail: detail)
        }
        .tint(.primary)
    }
    private func row(_ title: String, _ glyph: String, on: Bool, detail: Engine.Audience? = nil) -> some View {
        HStack {
            Label { Text(title) } icon: { Image("Glyphs/" + glyph).resizable().frame(width: 20, height: 20) }
            Spacer()
            if let detail { Engine.Access.label(detail.scope, detail.space, glyphs: false) }
            if on { Image(systemName: "checkmark").fontWeight(.semibold) }
        }
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

// Selected people …: the workspace's people, those who can see it now first and ticked, applied together
struct PeoplePicker: View {
    let access: Engine.Access
    let engine: Engine
    let apply: ([String]) -> Void
    @State private var people: [Engine.Member] = []
    @State private var picked: Set<String> = []
    @State private var query = ""

    var body: some View {
        List(people.filter { query.isEmpty || $0.name.localizedStandardContains(query) }) { person in
            Button { if picked.contains(person.id) { picked.remove(person.id) } else { picked.insert(person.id) } } label: {
                HStack {
                    Text(person.name).foregroundStyle(.primary)
                    Spacer()
                    if picked.contains(person.id) { Image(systemName: "checkmark").fontWeight(.semibold) }
                }
            }
        }
        .tint(.primary)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
        .navigationTitle("Select people")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Apply") { apply(Array(picked)) }.disabled(picked.isEmpty) } }
        .task {
            let seeing = Set(access.participants)
            picked = seeing
            people = await engine.members().filter { $0.id != access.me }
                .sorted { seeing.contains($0.id) != seeing.contains($1.id) ? seeing.contains($0.id) : $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        }
    }
}

extension View {
    // Assigned someone who cannot open it (Engine.assign): Grant access shares it with them, Keep private leaves it as it is
    func shareAsk(_ engine: Engine, on: Bool = true) -> some View {
        alert((engine.asking?.shut.names ?? "") + " can’t see this", isPresented: Binding { on && engine.asking != nil } set: { if !$0 { engine.asking = nil } }, presenting: engine.asking) { ask in
            if ask.access.grants {
                Button("Grant access") { Task { await engine.share(ask.id, "people", ask.access.participants + ask.shut.map(\.id)); await ask.then() } }
            }
            Button("Keep private", role: .cancel) {}
        } message: { ask in
            Text("“\(ask.access.title)” is assigned to \(ask.shut.names), but they won’t be able to open it unless you grant access or move it somewhere they can see."
                 + (ask.access.grants ? "" : " It is shared through where it lives, so share that instead."))
        }
    }
}
