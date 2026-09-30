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
// it. The box is its own button beside it, so ticking a task never opens it too (TaskList has them the same way).
struct ListRow: View {
    let row: Row
    let engine: Engine
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
                    if row.stateType != nil { TaskWords(row: row, done: engine.state(of: row) == "closed") } else { Text(row.styled) }
                    if let at = row.createdAt.flatMap(Row.parse) {
                        Text(at, format: .relative(presentation: .named)).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 6)
    }
}

// Zoomed into a node: a chat as its conversation, a saved search as its results, a meeting as the documents it owns,
// anything else as its outline. Read-only; a mention, a reference or a row opens the node it names.
struct NodeScreen: View {
    let engine: Engine
    let id: String
    var titled = true // false when the page is the menu's own and the shell names it
    var note: String? // what the composer that started this chat had to say (Shell: Tana did not answer, or saved for later)

    @State private var page: Engine.Page?
    @State private var error: String?

    var body: some View {
        Group {
            if let page, page.isPrivate == true {
                ContentUnavailableView("Private", systemImage: "lock", description: Text("You marked this sensitive in Orbital, so the phone does not show it."))
            } else if let page {
                switch page.kind {
                case "chat":
                    ChatView(rows: page.rows)
                        // sent is sent: the read after it is the next poll's job, so a failed read never offers to send it twice
                        .safeAreaInset(edge: .bottom) { Composer(prompt: "Follow up", note: note) { let sent = try await engine.send($0, to: id); await load(); return sent.warning } }
                case "search", "event":
                    List(page.rows) { ListRow(row: $0, engine: engine) }
                        .listStyle(.plain)
                        .refreshable { await load() }
                        .overlay { if page.rows.isEmpty { ContentUnavailableView(page.kind == "event" ? "No notes yet" : "Nothing found", image: "Glyphs/" + Glyph.of(page.kind)) } }
                default:
                    List(Array(Self.flat(page.rows).enumerated()), id: \.offset) { OutlineRow(row: $0.element.row, depth: $0.element.depth) }
                        .listStyle(.plain)
                        .refreshable { await load() }
                        .overlay { if page.rows.isEmpty { ContentUnavailableView("Nothing in here yet", image: "Glyphs/doc") } }
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
        .navigationTitle(titled ? page?.title ?? "" : "")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: engine.phase) {
            guard engine.phase == .ready else { return }
            await load()
            // A chat is read again every two seconds while it is on screen, so Tana's answer shows as it is written: the
            // document is live in the engine, so this is a local read, not a request. One that did not open yet (a chat
            // just started, still on its way to Tana) keeps being tried the same way.
            // ponytail: polled; have the engine call back on the chat's changes if this ever costs.
            while (page?.kind ?? Glyph.kind(of: id)) == "chat", !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                await load()
            }
        }
    }

    // A read keeps what is on screen when it fails, and says why only while there is nothing to show
    private func load() async {
        do { page = try await engine.open(id); error = nil } catch { self.error = error.localizedDescription }
    }

    // the outline flattened, each row with how deep it sits: nothing folds on the phone, everything shows
    static func flat(_ rows: [Row], depth: Int = 0) -> [(row: Row, depth: Int)] {
        rows.flatMap { [($0, depth)] + flat($0.children ?? [], depth: depth + 1) }
    }
}

// One block of an outline: a bullet and its words, indented by depth; a heading bigger and with no bullet; a reference
// its node's glyph and name, which opens it
struct OutlineRow: View {
    let row: Row
    let depth: Int
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
                if row.type == "image" || row.type == "table" { Text(row.type == "image" ? "Image" : "Table").foregroundStyle(.secondary) }
                else { Text(row.styled) }
            }
            .font(row.heading == 1 ? .title2.bold() : row.heading == 2 ? .title3.bold() : row.heading != nil ? .headline : .body)
            .frame(maxWidth: .infinity, alignment: .leading)
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

// A chat as the ChatGPT app shows one: your messages in grey bubbles on the right, Tana's answers as plain text under
// its name, what it did while thinking in grey, the documents it touched as rows that open them
struct ChatView: View {
    let rows: [Row]

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                ForEach(rows) { Message(row: $0) }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
        }
        .defaultScrollAnchor(.bottom)
    }
}

struct Message: View {
    let row: Row

    var body: some View {
        if row.chat?.status == true {
            Text(row.words).font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity)
        } else if row.chat?.mine == true {
            VStack(alignment: .leading, spacing: 8) { ForEach(row.children ?? []) { ChatBlock(row: $0) } }
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.leading, 48)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Text(row.words).font(.subheadline.weight(.semibold))
                    if let meta = row.meta { Text(meta).font(.subheadline).foregroundStyle(.secondary) }
                }
                ForEach(row.children ?? []) { ChatBlock(row: $0) }
                if row.chat?.streaming == true && (row.children ?? []).isEmpty { ProgressView().controlSize(.small) } // Tana has started, no words yet
            }
        }
    }
}

// One block of a message: a line of what it did (grey), a document (its glyph and name, opens it), code, or words
struct ChatBlock: View {
    let row: Row
    @Environment(\.openURL) private var openURL

    var body: some View {
        if row.note == true {
            Text(row.words).font(.subheadline).foregroundStyle(.secondary)
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
