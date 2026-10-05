import SwiftUI

// The desktop's glyph for a node's kind (main/rows.js): a task by its box, a meeting by its calendar
enum Glyph {
    static func of(_ kind: String?) -> String {
        switch kind {
        case "event": "calendar"
        case "space": "space"
        case "user-profile": "member"
        case "chat": "discuss"
        case "search": "search"
        default: "doc"
        }
    }
    // a node's kind from its id (tana:<kind>:<ulid>), and the glyph for it
    static func kind(of uri: String) -> String? { uri.split(separator: ":").dropFirst().first.map(String.init) }
    static func of(uri: String) -> String { of(kind(of: uri)) }
}

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
                    let at = row.createdAt.flatMap(Row.parse), people = row.people ?? []
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

// Zoomed into a node: a chat as its conversation, a saved search as its results, a meeting as the documents it owns,
// anything else as its outline. Read-only; a mention, a reference or a row opens the node it names.
struct NodeScreen: View {
    let engine: Engine
    let id: String
    var titled = true // false when the page is the menu's own and the shell names it
    var note: String? // what the composer that started this chat had to say (Shell: Tana did not answer, or saved for later)
    var asked: Date? // when the message that opened this chat was sent (Shell's Ask Tana): its answer is waited for

    @State private var page: Engine.Page?
    @State private var error: String?
    @State private var waitingSince: Date?
    @State private var waitOver = false // the two minutes an answer is waited for have passed: no dots any more (ChatView)
    @State private var access: Engine.Access? // a document's Assigned to and Visible to (NodeDetails)

    var body: some View {
        Group {
            // a node you marked sensitive: what it is, and how to see it, until a shake shows it (the title says Hidden, as the desktop's tab does)
            if let page, page.sensitive == true, !engine.reveal {
                ContentUnavailableView { Label { Text("Hidden") } icon: { Image("Glyphs/hidden").resizable().frame(width: 48, height: 48) } } description: { Text("You marked this sensitive in Orbital. Shake your iPhone or turn on Show sensitive items in Settings to see it, and do the same again to hide it.") }
            } else if let page {
                switch page.kind {
                case "chat":
                    ChatView(rows: page.rows, since: waitOver ? nil : waitingSince ?? asked, reveal: engine.reveal)
                        // sent is sent: the read after it is the chat's own change's job, so a failed read never offers to send it twice
                        .safeAreaInset(edge: .bottom) {
                            Composer(prompt: "Follow up", note: note) { let sent = try await engine.send($0, to: id); waitingSince = .now; await load(); return sent.warning }
                        }
                case "event" where page.summary != nil:
                    MeetingSummary(summary: page.summary ?? [], notes: page.notes, engine: engine)
                        .refreshable { await load() }
                case "search", "event":
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
                            if let title = section.title { Text(title).font(.headline).foregroundStyle(.secondary).textCase(nil) }
                        }
                        .listSectionSeparator(.hidden)
                    }
                        .listStyle(.plain)
                        .environment(\.defaultMinListRowHeight, 0) // the rows as tall as their words, not the system's 44
                        .refreshable { await load() }
                        .overlay { if page.rows.isEmpty { ContentUnavailableView(page.kind == "event" ? "No notes yet" : "Nothing found", image: "Glyphs/" + Glyph.of(page.kind)) } }
                default:
                    List {
                        if let access { NodeDetails(id: id, access: access, engine: engine, reload: load) }
                        ForEach(Array(Self.flat(page.rows).enumerated()), id: \.offset) { OutlineRow(row: $0.element.row, depth: $0.element.depth, reveal: engine.reveal, engine: engine) }
                    }
                        .listStyle(.plain)
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
        .navigationTitle(titled && !(page?.sensitive == true && !engine.reveal) ? engine.translator.words(page?.title ?? "", sensitive: page?.sensitive == true).0 : "")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: engine.phase) {
            guard engine.phase == .ready else { return }
            await load()
            // A chat that did not open yet (just started, still on its way to Tana) is tried every two seconds until it
            // does; from then on its changes say when to read it again (below)
            while page == nil, Glyph.kind(of: id) == "chat", !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                await load()
            }
        }
        // Changed in Tana, by anyone anywhere (ios/engine/live.js): read again, as the desktop's page on screen is. A chat's
        // answer shows as it is written; a saved search or a meeting takes a row added, changed or gone.
        .onChange(of: engine.changes[id]) { Task { await load() } }
        // an answer waited for two minutes at most (renderer/chat.js CHAT_WAIT): the dots go then, with nothing to read
        .task(id: waitingSince ?? asked) {
            waitOver = false
            guard let since = waitingSince ?? asked else { return }
            try? await Task.sleep(for: .seconds(max(0, 120 - Date.now.timeIntervalSince(since))))
            if !Task.isCancelled { waitOver = true }
        }
    }

    // A read keeps what is on screen when it fails, and says why only while there is nothing to show
    private func load() async {
        do { page = try await engine.open(id); error = nil } catch { self.error = error.localizedDescription }
        if let kind = page?.kind, !["chat", "search", "event"].contains(kind) { access = await engine.access(id) ?? access }
    }

    // consecutive rows under one heading; one untitled section when the search is not grouped
    static func sections(_ rows: [Row]) -> [(title: String?, rows: [Row])] {
        rows.reduce(into: []) { out, row in
            if let last = out.last, last.title == row.group { out[out.count - 1].rows.append(row) } else { out.append((row.group, [row])) }
        }
    }

    // the outline flattened, each row with how deep it sits: nothing folds on the phone, everything shows
    static func flat(_ rows: [Row], depth: Int = 0) -> [(row: Row, depth: Int)] {
        rows.filter { !$0.blank }.flatMap { [($0, depth)] + flat($0.children ?? [], depth: depth + 1) }
    }
}

// A meeting Tana has written up, as the desktop's page has it (renderer/meetingnotes.js): its summary, and Notes | Summary
// over it when you have notes for it too; with none, the summary alone. Read only, as every page here.
struct MeetingSummary: View {
    let summary: [Row]
    let notes: [Row]?
    let engine: Engine
    @State private var showNotes = false

    var body: some View {
        List {
            if notes != nil {
                Picker("Notes or summary", selection: $showNotes) { Text("Notes").tag(true); Text("Summary").tag(false) }
                    .pickerStyle(.segmented)
                    .listRowSeparator(.hidden)
            }
            ForEach(Array(NodeScreen.flat(showNotes ? notes ?? [] : summary).enumerated()), id: \.offset) {
                OutlineRow(row: $0.element.row, depth: $0.element.depth, reveal: engine.reveal, engine: engine)
            }
        }
        .listStyle(.plain)
    }
}

// An image in an outline (Engine.image): the word Image until its picture has come, then the picture, the row's width
struct OutlineImage: View {
    let uri: String
    let engine: Engine
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 8)).accessibilityLabel("Image") }
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
    var reveal = false
    var engine: Engine? // to fetch an image row's picture
    @Environment(\.openURL) private var openURL

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            if row.heading == nil {
                if let ref = row.reference {
                    Image("Glyphs/" + Glyph.of(uri: ref.uri)).resizable().frame(width: 18, height: 18).foregroundStyle(.secondary)
                        .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3.5 }
                } else {
                    Circle().fill(.tertiary).frame(width: 6, height: 6).frame(width: 18)
                        .alignmentGuide(.firstTextBaseline) { $0[.bottom] + 2.5 } // centred on the lower-case letters
                }
            }
            Group {
                if row.type == "image", let uri = row.image?.uri, let engine { OutlineImage(uri: uri, engine: engine) }
                else if row.type == "image" || row.type == "table" { Text(row.type == "image" ? "Image" : "Table").foregroundStyle(.secondary) }
                else { Text(row.styled) }
            }
            .font(row.heading == 1 ? .title2.bold() : row.heading == 2 ? .title3.bold() : row.heading != nil ? .headline : .body)
            .frame(maxWidth: .infinity, alignment: .leading)
            .modifier(Blur(hidden: row.sensitive == true && !reveal))
        }
        .padding(.leading, CGFloat(depth) * 22)
        .padding(.top, row.heading != nil ? 10 : 0)
        .listRowSeparator(.hidden)
        .contentShape(Rectangle())
        .onTapGesture { openURL.zoom(row.reference?.uri) }
        .accessibilityAddTraits(row.reference != nil ? .isButton : [])
        .accessibilityAction { openURL.zoom(row.reference?.uri) }
    }
}

// A chat as the desktop draws one (renderer/chat.js, styles.css .chat-msg): your messages in a blue bubble on the right,
// everyone else's as plain text across the page with their name over each run of them, what Tana did while thinking
// in grey over a hairline, and three dots while an answer is on its way (since: when the last message was sent).
struct ChatView: View {
    let rows: [Row]
    var since: Date?
    var reveal = false

    var body: some View {
        let shown = rows.enumerated().map { i, row in (row, Self.named(row, after: rows[..<i].last)) }
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                ForEach(shown, id: \.0.id) { Message(row: $0.0, named: $0.1, reveal: reveal).modifier(Blur(hidden: $0.0.sensitive == true && !reveal)) }
                if waiting { Dots().padding(.top, -8) }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
        }
        .defaultScrollAnchor(.bottom)
    }

    // the name over a run of replies, not over each (renderer/chat.js chatNameEl): a status line breaks the run
    static func named(_ row: Row, after prev: Row?) -> Bool {
        row.chat?.mine != true && row.chat?.status != true && (prev == nil || prev?.chat?.status == true || prev?.chat?.author != row.chat?.author)
    }
    // Tana writing (its message streaming with no words yet), or your message still unanswered for two minutes at most
    // (renderer/chat.js CHAT_WAIT)
    private var waiting: Bool {
        let last = rows.last { $0.chat?.status != true }
        if last?.chat?.streaming == true { return (last?.children ?? []).isEmpty }
        return last?.chat?.mine == true && since.map { Date.now.timeIntervalSince($0) < 120 } == true
    }
}

struct Message: View {
    let row: Row
    let named: Bool
    let reveal: Bool // a sensitive block inside a message stays blurred too, until a shake

    var body: some View {
        if row.chat?.status == true {
            Text(row.words).font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity)
        } else if row.chat?.mine == true {
            VStack(alignment: .leading, spacing: 8) { ForEach(row.children ?? []) { ChatBlock(row: $0).modifier(Blur(hidden: $0.sensitive == true && !reveal)) } }
                .foregroundStyle(Color.pair(0x1b2b41, 0xe8eeff))
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .background(Color.pair(0xeaf3fd, 0x1e3d7b), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.leading, 56)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                if named { Text(row.words).font(.subheadline.weight(.semibold)) }
                ForEach(row.children ?? []) { ChatBlock(row: $0).modifier(Blur(hidden: $0.sensitive == true && !reveal)) }
            }
        }
    }
}

// Three dots where the answer will be, as the desktop's (renderer/chat.js chatDotsEl); still under Reduce Motion
struct Dots: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        TimelineView(.animation(minimumInterval: 0.1, paused: reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 5) {
                ForEach(0..<3) { i in
                    Circle().frame(width: 7, height: 7).opacity(reduceMotion ? 0.5 : 0.25 + 0.75 * max(0, sin(t * 4 - Double(i) * 0.9)))
                }
            }
            .foregroundStyle(.secondary)
        }
        .accessibilityElement()
        .accessibilityLabel("Tana is writing")
    }
}

// One block of a message: a line of what it did (grey), a document (its glyph and name, opens it), code, or words
struct ChatBlock: View {
    let row: Row
    @Environment(\.openURL) private var openURL

    var body: some View {
        if row.note == true {
            VStack(alignment: .leading, spacing: 10) { Text(row.words).font(.subheadline).foregroundStyle(.secondary); Divider() }
        } else if let ref = row.reference {
            Button { openURL.zoom(ref.uri) } label: {
                Label { Text(row.words).lineLimit(1) } icon: { Image("Glyphs/" + Glyph.of(uri: ref.uri)).resizable().frame(width: 18, height: 18) }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(.fill.tertiary, in: Capsule())
            }
            .buttonStyle(.plain)
        } else if row.block == "divider" {
            Divider()
        } else if row.block == "bullet" || row.block == "numbered" {
            HStack(alignment: .firstTextBaseline, spacing: 8) { Text("•").foregroundStyle(.secondary); Text(row.styled) }
        } else if row.block == "code" {
            Text(row.words).font(.callout.monospaced()).padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        } else {
            Text(row.styled).font(row.heading != nil ? .headline : .body)
        }
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
                ForEach(Self.states, id: \.0) { state in
                    Button { Task { await engine.tick(id, to: state.0); await reload() } } label: {
                        if state.0 == now { Label(state.1, systemImage: "checkmark") } else { Text(state.1) }
                    }
                }
            } label: {
                HStack(spacing: 12) {
                    Text("Status").foregroundStyle(.secondary).frame(width: 100, alignment: .leading)
                    Text(Self.states.first { $0.0 == now }?.1 ?? "In Progress").foregroundStyle(.primary)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
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
        // handed to your Dot (Agents.swift): its name and its last Agent status line; a tap asks it again or takes it back
        if let held = access.agent {
            Menu {
                if let a = engine.agents.first(where: { $0.id == held.id }) { Button("Ask \(a.name) again …") { engine.handing = .init(id: id, agent: a, then: reload) } }
                Button("Unassign", role: .destructive) { Task { await engine.unhand(id); await reload() } }
            } label: {
                HStack(spacing: 12) {
                    Text("Agent").foregroundStyle(.secondary).frame(width: 100, alignment: .leading)
                    Label { Text(held.name + " · " + held.word) } icon: { Image("Glyphs/robot").resizable().frame(width: 18, height: 18) }.foregroundStyle(.primary)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
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

    static let states = [("proposed", "Inbox"), ("open", "In Progress"), ("closed", "Completed"), ("not_now", "Later")]

    // a field as the desktop draws one: its name in grey, its value after it, a line under it, the whole row the button
    // that changes it
    private func field(_ name: String, _ change: @escaping () -> Void, @ViewBuilder value: () -> some View) -> some View {
        Button(action: change) {
            HStack(spacing: 12) {
                Text(name).foregroundStyle(.secondary).frame(width: 100, alignment: .leading)
                value()
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .modifier(FieldLine())
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
        let (word, glyph) = switch scope {
        case "only-me": ("Only you", "lock")
        case "people": ("Selected people", "userLock")
        case "space": (space.map { "Members of " + $0 } ?? "Space members", "houseLock")
        case "everyone": ("Everyone", "users")
        default: ("Unknown", "hidden")
        }
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
    func shareAsk(_ engine: Engine) -> some View {
        alert((engine.asking?.shut.names ?? "") + " can’t see this", isPresented: Binding { engine.asking != nil } set: { if !$0 { engine.asking = nil } }, presenting: engine.asking) { ask in
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
