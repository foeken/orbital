import SwiftUI

// The app's frame, after the Codex and ChatGPT apps: a side menu behind the page (Timeline and Searches, search and
// settings), the page with its title between the menu and search buttons, and a composer at the bottom that will start
// a new Codex thread (#665). The bars are the system's, so they are Liquid Glass with nothing of ours drawn over them.
struct Shell: View {
    let engine: Engine
    // The menu's pages, and a saved search pinned to your sidebar (its id and title), which the menu lists under them
    enum Page: Hashable {
        case timeline, notifications, chats, searches, search(String, String)
        var title: String {
            switch self {
            case .timeline: "Timeline"
            case .notifications: "Notifications"
            case .chats: "Chats"
            case .searches: "Searches"
            case .search(_, let title): title
            }
        }
        var glyph: String {
            switch self {
            case .timeline: "timelineMenu"
            case .notifications: "notifyMenu"
            case .chats: "discussMenu"
            case .searches: "libraryMenu"
            case .search: "searchMenu"
            }
        }
    }

    @State private var page = Page.timeline
    @State private var path: [String] = [] // the nodes zoomed into from the page, as a push each
    @State private var pinned: [Page] = []
    @State private var menu = false
    @State private var settings = CommandLine.arguments.contains("-settings") // -settings: open, for design shots
    @State private var searching = false
    @State private var drag: CGFloat = 0 // how far a sideways swipe has moved the page, while it is under the finger
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    @Environment(Pushes.self) private var pushes
    private let width: CGFloat = 300

    var body: some View {
        ZStack(alignment: .leading) {
            SideMenu(page: $page, pinned: pinned, close: { path = []; show(false) }, search: { show(false); searching = true }, settings: { settings = true })
                .frame(width: width)
                .accessibilityHidden(!menu)
            NavigationStack(path: $path) {
                Group {
                    switch page {
                    case .timeline: TimelineScreen(engine: engine)
                    case .notifications: ListScreen(engine: engine, name: "notifications")
                    case .chats: ListScreen(engine: engine, name: "chats")
                    case .searches: ListScreen(engine: engine, name: "searches")
                    case .search(let id, _): NodeScreen(engine: engine, id: id, titled: false).id(id)
                    }
                }
                .navigationDestination(for: String.self) { NodeScreen(engine: engine, id: $0) }
                .navigationTitle(page.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { show(true) } label: { Image(systemName: "line.3.horizontal") }.accessibilityLabel("Menu")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { searching = true } label: { Image(systemName: "magnifyingglass") }.accessibilityLabel("Search")
                    }
                }
                .safeAreaInset(edge: .bottom) { Composer() }
            }
            // the whole screen, status bar included: a clip to the page's own frame cut the top bar off
            .mask { RoundedRectangle(cornerRadius: menu ? 44 : 0, style: .continuous).ignoresSafeArea() }
            // pushed aside, the page is a card with a hairline edge, as the ChatGPT app's is; a tap closes it. (A sheet
            // of glass over it was too much: the bar's own glass buttons became glass on glass.) Always there and only
            // shown or hidden: added and removed, it faded out where it had been while the page slid home, a second edge
            // lagging behind the first.
            .overlay {
                // a faint grey over the card in dark mode, so it reads as a sheet lifted off the black menu, as the
                // ChatGPT app's does; in light mode the shadow does that
                RoundedRectangle(cornerRadius: 44, style: .continuous).fill(Color.pair(0x000000, 0xffffff).opacity(scheme == .dark ? 0.08 : 0))
                    .overlay { RoundedRectangle(cornerRadius: 44, style: .continuous).strokeBorder(Color(.separator), lineWidth: 1) }
                    .ignoresSafeArea()
                    .opacity(menu ? 1 : 0)
                    .contentShape(Rectangle())
                    .onTapGesture { show(false) }
                    .allowsHitTesting(menu)
                    .accessibilityHidden(true)
            }
            .shadow(color: .black.opacity(menu ? 0.25 : 0), radius: 24)
            .offset(x: min(width, max(0, (menu ? width : 0) + drag)))
        }
        .background(Color(.systemBackground))
        // A mention, a reference or a row anywhere zooms into its node: an orbital:<id> link (Row.zoom) is pushed here
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme == "orbital" else { return .systemAction }
            searching = false
            path.append(String(url.absoluteString.dropFirst("orbital:".count)))
            return .handled
        })
        .task(id: engine.phase) {
            guard engine.phase == .ready, let searches = try? await engine.list("searches") else { return }
            pinned = searches.filter { $0.pinned == true }.map { .search($0.id, $0.words) }
        }
        // A sideways swipe anywhere, the menu included: the page follows the finger and settles open or shut, as the
        // ChatGPT app's does. Only a swipe that is more sideways than up or down counts, so the Timeline still scrolls.
        .simultaneousGesture(DragGesture(minimumDistance: 20)
            .onChanged { g in
                guard path.isEmpty, abs(g.translation.width) > abs(g.translation.height) else { return }
                drag = g.translation.width
            }
            .onEnded { g in
                let moved = path.isEmpty && abs(g.translation.width) > abs(g.translation.height) ? g.predictedEndTranslation.width : 0
                withAnimation(reduceMotion ? nil : Self.move) {
                    if moved > width / 3 { menu = true } else if moved < -width / 3 { menu = false }
                    drag = 0
                }
            })
        .sheet(isPresented: $settings) { SettingsView(engine: engine) }
        .task {
            // -page notifications|chats|searches and -zoom <id>: a page or a node open at launch, for design shots
            let args = CommandLine.arguments, after = { (flag: String) in args.firstIndex(of: flag).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
            if let name = after("-page") { page = ["notifications": .notifications, "chats": .chats, "searches": .searches][name] ?? .timeline }
            if let id = after("-zoom") { path = [id] }
            // -menudemo: open the menu and close it again, for filming the move
            guard args.contains("-menudemo") else { return }
            try? await Task.sleep(for: .seconds(2)); show(true)
            try? await Task.sleep(for: .seconds(2)); show(false)
        }
        .sheet(isPresented: $searching) { SearchSheet(engine: engine) }
        // a tapped push opens its node over the Timeline, whatever was on screen
        .task(id: pushes.opened) {
            guard let id = pushes.opened else { return }
            settings = false; searching = false; page = .timeline; show(false)
            path = [id]
            pushes.opened = nil
        }
    }

    private func show(_ open: Bool) {
        withAnimation(reduceMotion ? nil : Self.move) { menu = open }
    }

    // the menu's one move, quicker than SwiftUI's default half second
    static let move = Animation.snappy(duration: 0.3)
}

// The side menu: the app's name with search beside it, its pages, and settings at the foot
struct SideMenu: View {
    @Binding var page: Shell.Page
    let pinned: [Shell.Page]
    let close: () -> Void
    let search: () -> Void
    let settings: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Orbital").font(.title2.bold())
                Spacer()
                Button(action: search) { Image(systemName: "magnifyingglass").font(.title3).frame(width: 30, height: 30) }
                    .buttonStyle(.glass).buttonBorderShape(.circle).accessibilityLabel("Search")
            }
            .padding(.leading, 14)
            .padding(.bottom, 12)
            ForEach([Shell.Page.timeline, .notifications, .chats, .searches], id: \.self) { item($0) }
            // the saved searches pinned to your sidebar, as the ChatGPT app lists recent chats under its pages
            if !pinned.isEmpty {
                Divider().padding(.horizontal, 14).padding(.vertical, 12)
                ScrollView { VStack(spacing: 4) { ForEach(pinned, id: \.self) { item($0) } } }.scrollBounceBehavior(.basedOnSize)
            }
            Spacer()
            HStack {
                Spacer()
                Button(action: settings) { Image(systemName: "gearshape").font(.title3).frame(width: 30, height: 30) }
                    .buttonStyle(.glass).buttonBorderShape(.circle).accessibilityLabel("Settings")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func item(_ item: Shell.Page) -> some View {
                Button { page = item; close() } label: {
                    HStack(spacing: 14) {
                        Image("Glyphs/" + item.glyph).resizable().frame(width: 22, height: 22)
                        Text(item.title).fontWeight(.medium).lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(page == item ? AnyShapeStyle(.fill.secondary) : AnyShapeStyle(.clear), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(page == item ? .isSelected : [])
    }
}

// The composer, as the Codex app has it: what you type becomes a new chat with Tana. Sending comes next, so for now it
// says so for a moment rather than doing nothing.
struct Composer: View {
    @State private var text = CommandLine.arguments.contains("-typing") ? "Can you move the offsite to Thursday?" : "" // -typing: the open card, for design shots
    @State private var notYet = false
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        // Codex's composer: a capsule at rest, a card while you type in it (the words on top, send in its corner)
        let open = focused || !empty
        VStack(spacing: 6) {
            if notYet {
                Text("Asking Tana from here comes next.")
                    .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center).transition(.opacity)
            }
            // The words set the height: at rest a line of body text with 12 pt above and below it (46 pt, a capsule with
            // this radius), open the words with room under them for the send button's row. The button sits in the
            // bottom-right corner, the same distance from the edge on both sides whatever the text field measures.
            TextField("Ask Tana", text: $text, axis: .vertical).lineLimit(1...6).focused($focused)
                .padding(.leading, 18)
                .padding(.trailing, open ? 18 : 52)
                .padding(.top, open ? 16 : 12)
                .padding(.bottom, open ? 60 : 12)
                .overlay(alignment: .bottomTrailing) {
                    Button {
                        withAnimation { notYet = true }
                        Task { try? await Task.sleep(for: .seconds(4)); withAnimation { notYet = false } }
                    } label: {
                        // the Codex app's send: a grey circle while there is nothing to send, blue once there is
                        Image(systemName: "arrow.up").font(.body.weight(.semibold))
                            .foregroundStyle(empty ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.white))
                            .frame(width: 34, height: 34)
                            .background(Circle().fill(empty ? AnyShapeStyle(.fill.tertiary) : AnyShapeStyle(.blue)))
                    }
                    .buttonStyle(.plain)
                    .disabled(empty)
                    .accessibilityLabel("Ask Tana")
                    .padding(open ? 10 : 6)
                }
                .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 23, style: .continuous))
        }
        .padding(.horizontal, open ? 14 : 36) // inset as the Codex app's composer is at rest; wider while you type, as its card is
        .padding(.bottom, 4)
        .animation(reduceMotion ? nil : .snappy, value: open)
    }
}

// Search over Tana from the top bar or the menu: Tana's own text search, newest change first; a result zooms into it
struct SearchSheet: View {
    let engine: Engine
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL // the shell's: a result zooms into its node, and the sheet goes
    @State private var text = ""
    @State private var found: [Engine.Found] = []
    @State private var asked = ""

    var body: some View {
        NavigationStack {
            List(found) { item in
                Button { if let url = Row.zoom(item.id) { openURL(url) } } label: {
                    HStack(spacing: 12) {
                        Image("Glyphs/" + Self.glyph(item)).resizable().frame(width: 20, height: 20).foregroundStyle(.secondary)
                        Text(item.title).foregroundStyle(.primary).lineLimit(2)
                    }
                }
            }
            .listStyle(.plain)
            .overlay { if found.isEmpty && !asked.isEmpty { ContentUnavailableView.search(text: asked) } }
            .searchable(text: $text, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search Tana")
            .task(id: text) {
                try? await Task.sleep(for: .milliseconds(300)) // a pause in typing, not every letter
                guard !Task.isCancelled else { return }
                found = await engine.search(text)
                asked = text.trimmingCharacters(in: .whitespaces)
            }
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    // the desktop's glyph for a kind (main/rows.js): a task by its state, a meeting by its calendar
    static func glyph(_ item: Engine.Found) -> String { item.kind == "text" && item.state != nil ? "task" : Glyph.of(item.kind) }
}
