import SwiftUI

// The app's frame, after the Codex and ChatGPT apps: a side menu behind the page (the Timeline, your saved searches and
// settings), the page with the menu button and its title, and a composer at the bottom that starts a chat with Tana.
// The bars are the system's, so they are Liquid Glass with nothing of ours drawn over them.
struct Shell: View {
    let engine: Engine
    // The menu's pages: the Timeline, and each saved search (its id and title) under it
    enum Page: Hashable {
        case timeline, search(String, String)
        var title: String { if case .search(_, let title) = self { title } else { "Timeline" } }
        var glyph: String { self == .timeline ? "timelineMenu" : "searchMenu" }
    }

    @State private var page = Page.timeline
    @State private var path: [String] = [] // the nodes zoomed into from the page, as a push each
    @State private var notes: [String: String] = [:] // chat id -> what its first message's send had to say, for the chat's own composer
    @State private var searches: [Page] = []
    @State private var icons: [String: UIImage] = [:] // saved search id -> the icon it was given in Orbital
    @State private var menu = false
    @State private var settings = CommandLine.arguments.contains("-settings") // -settings: open, for design shots
    @State private var drag: CGFloat = 0 // how far a sideways swipe has moved the page, while it is under the finger
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    private let width: CGFloat = 300

    var body: some View {
        ZStack(alignment: .leading) {
            SideMenu(page: $page, searches: searches, icons: icons, close: { path = []; show(false) }, settings: { settings = true })
                .frame(width: width)
                .accessibilityHidden(!menu)
            NavigationStack(path: $path) {
                Group {
                    switch page {
                    case .timeline: TimelineScreen(engine: engine)
                    case .search(let id, _): NodeScreen(engine: engine, id: id, titled: false).id(id)
                    }
                }
                .navigationDestination(for: String.self) { NodeScreen(engine: engine, id: $0, note: notes[$0]) }
                .navigationTitle(page.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { show(true) } label: { Image(systemName: "line.3.horizontal") }.accessibilityLabel("Menu")
                    }
                }
                .safeAreaInset(edge: .bottom) { Composer { let sent = try await engine.ask($0); notes[sent.id] = sent.warning; path.append(sent.id); return nil } } // a new chat, opened as it starts, its warning shown there
            }
            .accessibilityHidden(menu) // with the menu open, VoiceOver reads the menu, not the page pushed aside
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
            path.append(String(url.absoluteString.dropFirst("orbital:".count)))
            return .handled
        })
        .task(id: engine.phase) { await loadSearches() }
        // However it opens (the button, a swipe): the composer's keyboard goes, and the saved searches are read again, so
        // one pinned or given an icon on the Mac since shows up
        .onChange(of: menu) {
            guard menu else { return }
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            Task { await loadSearches() }
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
            // -zoom <id>: a node open at launch, for design shots
            let args = CommandLine.arguments
            if let i = args.firstIndex(of: "-zoom"), i + 1 < args.count { path = [args[i + 1]] }
            // -menudemo: open the menu and close it again, for filming the move
            guard args.contains("-menudemo") else { return }
            try? await Task.sleep(for: .seconds(2)); show(true)
            try? await Task.sleep(for: .seconds(2)); show(false)
        }
    }

    private func show(_ open: Bool) {
        withAnimation(reduceMotion ? nil : Self.move) { menu = open }
    }

    // your saved searches for the menu, with the icons they were given in Orbital; the last list stays when a read fails
    private func loadSearches() async {
        guard engine.phase == .ready, let found = try? await engine.searches() else { return }
        searches = found.map { .search($0.id, $0.words) }
        icons = Dictionary(found.compactMap { row in
            row.glyph.flatMap { Data(base64Encoded: $0) }.flatMap { UIImage(data: $0, scale: 3) }.map { (row.id, $0) }
        }, uniquingKeysWith: { first, _ in first })
    }

    // the menu's one move, quicker than SwiftUI's default half second
    static let move = Animation.snappy(duration: 0.3)
}

// The side menu: the app's name, its pages, and settings at the foot
struct SideMenu: View {
    @Binding var page: Shell.Page
    let searches: [Shell.Page]
    let icons: [String: UIImage]
    let close: () -> Void
    let settings: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Orbital").font(.title2.bold())
                .frame(minHeight: 46) // level with the page's menu button beside it
                .padding(.leading, 14)
                .padding(.bottom, 12)
            item(.timeline)
            // Your saved searches, those pinned to your sidebar first, as the ChatGPT app lists chats under its pages.
            // They run to the foot of the screen and scroll under the settings button, fading out behind it rather than
            // stopping at a hard line above it.
            if !searches.isEmpty {
                Divider().padding(.horizontal, 14).padding(.vertical, 12)
                ScrollView { VStack(spacing: 4) { ForEach(searches, id: \.self) { item($0) } }.padding(.bottom, 96) }
                    .scrollBounceBehavior(.basedOnSize)
                    .mask { VStack(spacing: 0) { Color.black; LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: 90) } }
                    .ignoresSafeArea(.container, edges: .bottom) // down to the screen's edge, under the home indicator
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .overlay(alignment: .bottomTrailing) {
            Button(action: settings) { Image(systemName: "gearshape").font(.title3).frame(width: 30, height: 30) }
                .buttonStyle(.glass).buttonBorderShape(.circle).accessibilityLabel("Settings")
                .padding(.horizontal, 12).padding(.bottom, 8)
        }
        .ignoresSafeArea(.keyboard) // the composer's keyboard does not squeeze the menu
    }

    private func item(_ item: Shell.Page) -> some View {
        Button { page = item; close() } label: {
            HStack(spacing: 14) {
                // a saved search by the icon you gave it in Orbital (Set icon), else the search glyph
                Group {
                    if case .search(let id, _) = item, let icon = icons[id] { Image(uiImage: icon).renderingMode(.template).resizable() }
                    else { Image("Glyphs/" + item.glyph).resizable() }
                }
                .frame(width: 22, height: 22)
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

// The composer, as the Codex app has it: what you type goes to Tana, as a new chat from the page (Shell) or a follow-up
// in a chat (ChatView). The words go the moment it is sent, and come back with the reason if Tana refuses them; a
// message sent that Tana did not answer stays sent, with the warning send hands back shown under the box.
struct Composer: View {
    var prompt = "Ask Tana"
    var note: String? // a line to start with (NodeScreen: what the send that opened this chat said)
    let send: (String) async throws -> String?
    @State private var text = CommandLine.arguments.contains("-typing") ? "Can you move the offsite to Thursday?" : "" // -typing: the open card, for design shots
    @State private var failure: String?
    @State private var noted = false
    @State private var sending = false
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        // Codex's composer: a capsule at rest, a card while you type in it (the words on top, send in its corner)
        let open = focused || !empty
        VStack(spacing: 6) {
            if let failure {
                Text(failure).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center).transition(.opacity)
            }
            // The words set the height: at rest a line of body text with 12 pt above and below it (46 pt, a capsule with
            // this radius), open the words with room under them for the send button's row. The button sits in the
            // bottom-right corner, the same distance from the edge on both sides whatever the text field measures.
            TextField(prompt, text: $text, axis: .vertical).lineLimit(1...6).focused($focused)
                .padding(.leading, 18)
                .padding(.trailing, open ? 18 : 52)
                .padding(.top, open ? 16 : 12)
                .padding(.bottom, open ? 60 : 12)
                .overlay(alignment: .bottomTrailing) {
                    Button {
                        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        text = ""; focused = false; sending = true
                        Task {
                            do { let warning = try await send(words); withAnimation { failure = warning } }
                            catch { text = words; withAnimation { failure = error.localizedDescription } }
                            sending = false
                        }
                    } label: {
                        // the Codex app's send: a grey circle while there is nothing to send, blue once there is
                        Image(systemName: "arrow.up").font(.body.weight(.semibold))
                            .foregroundStyle(empty ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.white))
                            .frame(width: 34, height: 34)
                            .background(Circle().fill(empty ? AnyShapeStyle(.fill.tertiary) : AnyShapeStyle(.blue)))
                    }
                    .buttonStyle(.plain)
                    .disabled(empty || sending)
                    .accessibilityLabel(prompt)
                    .padding(open ? 10 : 6)
                }
                .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 23, style: .continuous))
        }
        .padding(.horizontal, open ? 14 : 36) // inset as the Codex app's composer is at rest; wider while you type, as its card is
        .padding(.bottom, focused ? 14 : 4) // clear of the keyboard while you type, as the Codex app's card is
        .animation(reduceMotion ? nil : .snappy, value: open)
        .animation(reduceMotion ? nil : .snappy, value: focused)
        .onAppear { if !noted { failure = note; noted = true } }
        .task { if CommandLine.arguments.contains("-typing") { try? await Task.sleep(for: .seconds(1)); focused = true } } // -typing: with the keyboard up
    }
}
