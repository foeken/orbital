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
        var searchID: String? { if case .search(let id, _) = self { id } else { nil } }
    }

    @State private var page = Page.timeline
    @State private var path: [String] = [] // the nodes zoomed into from the page, as a push each
    @State private var notes: [String: String] = [:] // chat id -> what its first message's send had to say, for the chat's own composer
    @State private var asked: [String: Date] = [:] // chat id -> when Ask Tana sent its first message, whose answer it waits for
    @State private var searches: [Page] = []
    @State private var icons: [String: UIImage] = [:] // saved search id -> the icon it was given in Orbital
    @State private var secret: Set<String> = [] // the saved searches marked sensitive, drawn so in the menu too
    @State private var menu = false
    @State private var settings = CommandLine.arguments.contains("-settings") // -settings: open, for design shots
    @State private var adding = CommandLine.arguments.contains("-add") // Quick Add Task; -add: open, for design shots
    @State private var shared: Shared? // shared to Orbital: Quick Add opened with it
    @Environment(\.scenePhase) private var scene
    @State private var drag: CGFloat = 0 // how far a sideways swipe has moved the page, while it is under the finger
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        GeometryReader { proxy in
            let inset = proxy.safeAreaInsets
            let screen = CGSize(width: proxy.size.width + inset.leading + inset.trailing, height: proxy.size.height + inset.top + inset.bottom)
            // front: one page on a screen as square as an iPhone Duo's, either way up (any other iPhone's short side is
            // under 0.6 of its long one)
            let wide = Self.wide(screen), front = !wide && min(screen.width, screen.height) / max(screen.width, screen.height) > 0.6
            // corner: + at the bottom right, beside Ask Tana, where iOS keeps no side strip: two columns, or an unfolded
            // iPhone Duo upright (its long side about 890 pt; the front screen's is under 700)
            content(menuWidth: Self.menuWidth(for: proxy.size.width), wide: wide, front: front,
                    corner: wide || (front && max(screen.width, screen.height) >= 800))
        }
    }

    // Two columns: the whole screen on its side, at least 800 by 600 pt: an iPhone Duo unfolded (951 by 669 pt).
    // Upright, the front screen either way and any other iPhone on its side (440 pt tall at most): one page. By the room
    // the screen gives, not by device model.
    static func wide(_ screen: CGSize) -> Bool { screen.width > screen.height && screen.width >= 800 && screen.height >= 600 }

    // the saved search of tasks the Timeline sets beside it when wide: the one called Tasks, else the menu's first
    private var tasks: Page? { searches.first { $0.title.localizedCaseInsensitiveCompare("Tasks") == .orderedSame } ?? searches.first }

    // The menu keeps its familiar 300 pt phone width, but grows with a wide window so the page and menu both retain
    // useful room after a rotation or a fold. This is about the space SwiftUI gives us, not a list of device models.
    private static func menuWidth(for available: CGFloat) -> CGFloat {
        min(360, max(300, available * 0.4))
    }

    // front: an iPhone Duo's front screen, where the menu slides the page's content and leaves its frame, with iOS's side
    // bar down the right edge, where it is. Moving the frame changed the room iOS lays that bar out in, and the buttons
    // flashed back to the top bar each time it did.
    private func content(menuWidth: CGFloat, wide: Bool, front: Bool, corner: Bool) -> some View {
        let shift = min(menuWidth, max(0, (menu ? menuWidth : 0) + drag))
        return ZStack(alignment: .leading) {
            if !front { sideMenu(width: menuWidth, front: front) }
            NavigationStack(path: $path) {
                // front: the menu inside the page's frame, behind its content, which is what slides; outside, the frame
                // (and its views, though they show nothing there) lay over the menu and took every tap
                ZStack(alignment: .leading) {
                    if front { sideMenu(width: menuWidth, front: front) }
                    Group {
                        switch page {
                        // the Tasks search beside the Timeline when there is room, else the first search in the menu
                        case .timeline: TimelineScreen(engine: engine, tasks: tasks, wide: wide, ask: ask, add: { adding = true })
                        case .search(let id, _): NodeScreen(engine: engine, id: id, titled: false).id(id)
                        }
                    }
                    // front: under the side strip, empty down there, so it sits as far from the screen's right edge as its left
                    // corner: + beside it at the bottom right (CornerAdd)
                    .safeAreaInset(edge: .bottom) {
                        if !(wide && page == .timeline && tasks != nil) { // two columns: under the tasks column (TimelineScreen)
                            HStack(alignment: .bottom, spacing: 0) {
                                Composer(lifts: !corner, send: ask).ignoresSafeArea(.container, edges: front ? .trailing : [])
                                if corner { CornerAdd(engine: engine) { adding = true } }
                            }
                        }
                    }
                    // a bar of its own: what scrolls under the title fades out there, as under the top bar
                    .safeAreaBar(edge: .top) {
                        if front { Text(page.title).font(.headline).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.vertical, 10).accessibilityAddTraits(.isHeader) }
                    }
                    .modifier(Card(on: front, open: menu, shift: shift, dark: scheme == .dark, close: { show(false) }))
                }
                // wide (an unfolded iPhone Duo): + at the bottom right, beside Ask Tana (CornerAdd). In the side strip it made
                // the strip come and go as a node opened over it, and the bar jumped; a node's back button went down it too.
                .modifier(TopBar(on: wide)) // wide: no side strip, the menu and back buttons in the top bar
                .navigationDestination(for: String.self) { NodeScreen(engine: engine, id: $0, note: notes[$0], asked: asked[$0]).modifier(TopBar(on: wide)) }
                .navigationTitle(front ? "" : page.title) // front: the title slides with the page, below
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    // An iPhone Duo's front screen: both down its side bar (left to iOS they flashed back to the top bar)
                    #if compiler(>=6.4)
                    if #available(iOS 27.1, *) {
                        menuButton.axisBehavior(.verticalPreferred)
                        if !corner { addButton.axisBehavior(.verticalPreferred) }
                    } else { menuButton; if !corner { addButton } }
                    #else
                    menuButton; if !corner { addButton }
                    #endif
                }
            }
            .modifier(Card(on: !front, open: menu, shift: shift, dark: scheme == .dark, close: { show(false) }))
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
                    if moved > menuWidth / 3 { menu = true } else if moved < -menuWidth / 3 { menu = false }
                    drag = 0
                }
            })
        .sheet(isPresented: $settings) { SettingsView(engine: engine) }
        .sheet(isPresented: $adding) { QuickAdd(engine: engine, search: path.isEmpty ? page.searchID : nil) } // on a saved search: a row of it
        // what was shared opens Quick Add: its words to edit, or its image, read only once tapped there (any app can start
        // the share screen; security review finding 9, as Android's QuickAdd.kt)
        .sheet(item: $shared) { QuickAdd(engine: engine, shared: $0) }
        .onChange(of: engine.made) { if let id = engine.made { engine.made = nil; path.append(id) } } // an image's node, made: opened
        .onOpenURL(perform: open)
        // what was shared opens Quick Add over nothing else
        .onChange(of: scene, initial: true) {
            guard scene == .active else { return }
            if let found = Shared.take() { adding = false; settings = false; shared = found }
            // a widget's box ticked where the app could not take it at once (TickTaskIntent): with the Timeline in front
            for t in Writes.take() { page = .timeline; path = []; Task { await engine.tick(t.id, to: t.to) } }
        }
        .sheet(item: Binding { engine.assigning } set: { engine.assigning = $0 }) { AssignSheet(engine: engine, task: $0) }
        .sheet(item: Binding { engine.pickingDay } set: { engine.pickingDay = $0 }) { PinDaySheet(engine: engine, picking: $0) } // a pin menu's Pick a Date …
        .sheet(item: Binding { engine.handing } set: { engine.handing = $0 }) { HandSheet(engine: engine, handing: $0) } // Assign to your Dot (Agents.swift)
        .shareAsk(engine)
        .task {
            // -zoom <id>: a node open at launch, for design shots
            let args = CommandLine.arguments
            if let i = args.firstIndex(of: "-zoom"), i + 1 < args.count { path = [args[i + 1]] }
            // -open <link>: an orbital: link opened at launch, as Siri or a widget opens one, for the UI tests (a link
            // opened from outside asks first whether to open Orbital, which a test would wait on)
            if let i = args.firstIndex(of: "-open"), i + 1 < args.count, let url = URL(string: args[i + 1]) { open(url) }
            // -menu: the menu open and left so, for design shots (the manual's, manual/scenes/iphone.sh)
            if args.contains("-menu") { show(true) }
            // -menudemo: open the menu and close it again, for filming the move
            guard args.contains("-menudemo") else { return }
            try? await Task.sleep(for: .seconds(2)); show(true)
            try? await Task.sleep(for: .seconds(2)); show(false)
        }
    }

    private func show(_ open: Bool) {
        withAnimation(reduceMotion ? nil : Self.move) { menu = open }
    }

    private func sideMenu(width: CGFloat, front: Bool) -> some View {
        SideMenu(page: $page, searches: $searches, icons: icons, hidden: engine.reveal ? [] : secret, moved: saveOrder, pick: { item in
            if !path.isEmpty { path = [] }
            // front: the new page once the old one has slid home. Swapped any sooner, the page came back shut at once,
            // with no slide (the content slides inside the frame there, and a new page in it ended the move)
            guard front, item != page else { page = item; show(false); return }
            withAnimation(reduceMotion ? nil : Self.move, completionCriteria: .logicallyComplete) { menu = false } completion: { page = item }
        }, settings: { settings = true })
            .frame(width: width)
            .accessibilityHidden(!menu)
    }

    private var menuButton: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            // in an iPhone Duo's side bar it stays in reach with the menu open: a second tap closes it
            Button { show(!menu) } label: { Image(systemName: "line.3.horizontal") }.accessibilityLabel("Menu")
        }
    }

    private var addButton: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button { adding = true } label: { AddGlyph(busy: engine.adding > 0) }
                .accessibilityLabel("Quick Add Task").accessibilityValue(engine.adding > 0 ? "Adding" : "")
        }
    }

    // Ask Tana: a new chat, opened as it starts, its warning shown there
    private func ask(_ text: String) async throws -> String? {
        let sent = try await engine.ask(text); notes[sent.id] = sent.warning; asked[sent.id] = .now; path.append(sent.id); return nil
    }

    // The Share extension opens Orbital with orbital-share://; what it shared waits until Orbital is in front, should iOS
    // not open it. An orbital: link only opens, whoever sends it (a widget's tap, another app, a web page), since iOS
    // does not say who did, and Orbital's own writes go through intents (TickTaskIntent, Intents.swift): orbital:add
    // Quick Add, orbital:timeline the Timeline, orbital:<id> that node over it; orbital:check:, uncheck:, pin: and
    // unpin:<id> that node too, where you tick or pin it yourself, and orbital:new?title=… Quick Add with its title,
    // added only when you press Add (Android's Link.parse with own false, docs/ANDROID.md Security).
    private func open(_ url: URL) {
        guard url.scheme == "orbital" else { shared = Shared.take() ?? shared; return }
        let what = String(url.absoluteString.dropFirst("orbital:".count))
        settings = false; adding = what == "add"; show(false)
        if what == "timeline" { page = .timeline; path = [] }
        if let id = ["", "check:", "uncheck:", "pin:", "unpin:"].lazy.compactMap({ what.hasPrefix($0) ? String(what.dropFirst($0.count)) : nil })
            .first(where: { $0.wholeMatch(of: /tana:[a-z-]+:[0-9a-z]{26}/) != nil }) { page = .timeline; path = [id] }
        if what.hasPrefix("new?"), let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
           let title = items.first(where: { $0.name == "title" })?.value?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
            shared = Shared(text: title)
        }
    }

    // your saved searches for the menu, with the icons they were given in Orbital; the last list stays when a read fails
    // The order you dragged the searches into, kept on this phone; one you never moved keeps its place after them, in
    // the engine's order (your desktop pins first, then the newest)
    // ponytail: on this phone only; the desktop's sidebar order is its own pin tree, written when wanted (sdk/pins placePin)
    private static let orderKey = "searchOrder"
    private func saveOrder() { UserDefaults.standard.set(searches.compactMap(\.searchID), forKey: Self.orderKey) }
    static func ordered(_ list: [Page]) -> [Page] {
        let saved = UserDefaults.standard.stringArray(forKey: orderKey) ?? []
        let rank = Dictionary(saved.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        let at = { (i: Int, p: Page) in rank[p.searchID ?? ""] ?? saved.count + i }
        return list.enumerated().sorted { at($0.offset, $0.element) < at($1.offset, $1.element) }.map(\.element)
    }

    private func loadSearches() async {
        guard engine.phase == .ready, let found = try? await engine.searches() else { return }
        searches = Self.ordered(found.map { .search($0.id, $0.words) })
        secret = Set(found.filter { $0.sensitive == true }.map(\.id))
        icons = Dictionary(found.compactMap { row in
            row.glyph.flatMap { Data(base64Encoded: $0) }.flatMap { UIImage(data: $0, scale: 3) }.map { (row.id, $0) }
        }, uniquingKeysWith: { first, _ in first })
    }

    // the menu's one move, quicker than SwiftUI's default half second
    static let move = Animation.snappy(duration: 0.3)
}

// The page pushed aside for the menu (on): a card with a hairline edge, as the ChatGPT app's is; a tap closes it. Off it
// stays, every part at nothing, so a fold or an unfold keeps what is on screen. (A sheet of glass over it was too much:
// the bar's own glass buttons became glass on glass.) Always there and only shown or hidden: added and removed, it faded
// out where it had been while the page slid home, a second edge lagging behind the first.
private struct Card: ViewModifier {
    let on: Bool
    let open: Bool
    let shift: CGFloat
    let dark: Bool
    let close: () -> Void

    func body(content: Content) -> some View {
        let open = on && open
        content
            .background { if on { Color(.systemBackground).ignoresSafeArea() } } // the menu behind is seen only past it
            // the whole screen, status bar included: a clip to the page's own frame cut the top bar off
            .mask { RoundedRectangle(cornerRadius: open ? 44 : 0, style: .continuous).ignoresSafeArea() }
            .overlay {
                // a faint grey over the card in dark mode, so it reads as a sheet lifted off the black menu, as the
                // ChatGPT app's does; in light mode the shadow does that
                RoundedRectangle(cornerRadius: 44, style: .continuous).fill(Color.pair(0x000000, 0xffffff).opacity(dark ? 0.08 : 0))
                    .overlay { RoundedRectangle(cornerRadius: 44, style: .continuous).strokeBorder(Color(.separator), lineWidth: 1) }
                    .ignoresSafeArea()
                    .opacity(open ? 1 : 0)
                    .contentShape(Rectangle())
                    .onTapGesture(perform: close)
                    .allowsHitTesting(open)
                    .accessibilityHidden(true)
            }
            .shadow(color: .black.opacity(open ? 0.12 : 0), radius: 24)
            .offset(x: on ? shift : 0)
            .accessibilityHidden(open) // with the menu open, VoiceOver reads the menu, not the page pushed aside
    }
}

// The bar's buttons kept in the top bar (on) on an iPhone Duo (iOS 27.1), where they would go down the screen's edge
// shortcut: compiler(>=6.4) lets Xcode 27.0 in too, whose SDK lacks this; drop the #if once 27.1 is the oldest Xcode used
private struct TopBar: ViewModifier {
    let on: Bool
    func body(content: Content) -> some View {
        #if compiler(>=6.4)
        if #available(iOS 27.1, *) { content.toolbarVerticalBehavior(on ? .disabled : .automatic) } else { content }
        #else
        content
        #endif
    }
}

// + at the bottom right of a wide screen, in Ask Tana's row so the box, open or not, keeps clear of it
struct CornerAdd: View {
    let engine: Engine
    let add: () -> Void
    var body: some View {
        Button(action: add) { AddGlyph(busy: engine.adding > 0).font(.title3).frame(width: 30, height: 30) }
            .buttonStyle(.glass).buttonBorderShape(.circle)
            .accessibilityLabel("Quick Add Task").accessibilityValue(engine.adding > 0 ? "Adding" : "")
            .padding(.trailing, 25).padding(.bottom, 6) // under the middle of the status bar's icons above it (measured)
    }
}

// The + in the bar: a thin ring turns around it while what Quick Add handed over is still being made (Engine.adding). It
// stays the button it was, so another task can be added meanwhile.
struct AddGlyph: View {
    let busy: Bool
    var body: some View {
        Image(systemName: "plus")
            .overlay {
                if busy {
                    TimelineView(.animation) { context in
                        Circle().trim(from: 0, to: 0.3)
                            .stroke(.secondary, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                            .rotationEffect(.degrees(context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1) * 360))
                    }
                    .frame(width: 28, height: 28)
                    .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.2), value: busy)
    }
}

// The side menu: the app's name, its pages, and settings at the foot
struct SideMenu: View {
    @Binding var page: Shell.Page
    @Binding var searches: [Shell.Page]
    let icons: [String: UIImage]
    let hidden: Set<String> // sensitive and not shown by a shake
    let moved: () -> Void // the order changed: Shell keeps it
    let pick: (Shell.Page) -> Void // a page chosen: Shell shows it and closes the menu
    let settings: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Orbital").font(.title2.bold())
                .frame(minHeight: 46) // level with the page's menu button beside it
                .padding(.leading, 14)
                .padding(.bottom, 12)
            item(.timeline)
            // Your saved searches, as the ChatGPT app lists chats under its pages; a long press picks one up to move it
            // (the List's own reordering). They run to the foot of the screen and scroll under the settings button,
            // fading out behind it rather than stopping at a hard line above it.
            if !searches.isEmpty {
                Divider().padding(.horizontal, 14).padding(.vertical, 12)
                List {
                    ForEach(Array(searches.enumerated()), id: \.element) { i, search in
                        item(search)
                            .accessibilityAction(named: "Move up") { move(i, by: -1) }
                            .accessibilityAction(named: "Move down") { move(i, by: 1) }
                            .listRowInsets(EdgeInsets(top: 2, leading: 0, bottom: 2, trailing: 0))
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                    }
                    .onMove { from, to in searches.move(fromOffsets: from, toOffset: to); moved() }
                    Color.clear.frame(height: 96).listRowSeparator(.hidden).listRowBackground(Color.clear) // clear of the settings button
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .environment(\.defaultMinListRowHeight, 0)
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

    // VoiceOver's way to reorder, which a long-press drag is not
    private func move(_ i: Int, by step: Int) {
        let to = i + step
        guard searches.indices.contains(to) else { return }
        searches.swapAt(i, to)
        moved()
    }

    private func item(_ item: Shell.Page) -> some View {
        Button { pick(item) } label: {
            HStack(spacing: 14) {
                // a saved search by the icon you gave it in Orbital (Set icon), else the search glyph
                Group {
                    if case .search(let id, _) = item, let icon = icons[id] { Image(uiImage: icon).renderingMode(.template).resizable() }
                    else { Image("Glyphs/" + item.glyph).resizable() }
                }
                .frame(width: 22, height: 22)
                Text(item.title).fontWeight(.medium).lineLimit(1).modifier(Blur(hidden: item.searchID.map(hidden.contains) ?? false))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(page == item ? AnyShapeStyle(.fill.tertiary) : AnyShapeStyle(.clear), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
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
    var lifts = true // up off the bottom while you type; false where + sits beside it (CornerAdd), level with it
    let send: (String) async throws -> String?
    @State private var text = CommandLine.arguments.contains("-typing") ? "Can you move the offsite to Thursday?" : "" // -typing: the open card, for design shots
    @State private var failure: String?
    @State private var noted = false
    @State private var sending = false
    @State private var dictation = Dictation() // dictating, on the open card (Dictation.swift)
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        // Codex's composer: a capsule at rest, a card while you type in it (the words on top, send in its corner)
        let busy = dictation.busy // listening, or writing down what was said
        let open = focused || !empty || busy
        VStack(spacing: 6) {
            if let failure = failure ?? dictation.problem {
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
                .overlay(alignment: .bottom) {
                    // the card's bottom row: dictating, only while you are in the card (or it still listens), then send;
                    // while it listens ✕, the dots and ■ take the row, as Codex's own dictation bar
                    HStack(spacing: 8) {
                        if !dictation.recording { Spacer(minLength: 0) }
                        if focused || busy { Dictate(dictation: dictation, into: $text) }
                        Button { Task { await submit() } } label: {
                            // the Codex app's send: a grey circle while there is nothing to send, blue once there is
                            Image(systemName: "arrow.up").font(.body.weight(.semibold))
                                .foregroundStyle(empty && !busy ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.white))
                                .frame(width: 34, height: 34)
                                .background(Circle().fill(empty && !busy ? AnyShapeStyle(.fill.tertiary) : AnyShapeStyle(.blue)))
                        }
                        .buttonStyle(.plain)
                        .disabled((empty && !busy) || sending || dictation.settling)
                        .accessibilityLabel(prompt)
                    }
                    .padding(open ? 10 : 6)
                }
                .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 23, style: .continuous))
        }
        .padding(.leading, open ? 14 : 36) // inset as the Codex app's composer is at rest; wider while you type, as its card is
        .padding(.trailing, lifts ? (open ? 14 : 36) : 12) // beside + (CornerAdd): the usual gap to it
        .padding(.bottom, focused && lifts ? 14 : 4) // clear of the keyboard while you type, as the Codex app's card is
        .animation(reduceMotion ? nil : .snappy, value: open)
        .animation(reduceMotion ? nil : .snappy, value: focused)
        .animation(reduceMotion ? nil : .snappy, value: dictation.recording)
        .onDisappear { dictation.cancel() } // the page left while listening: nothing kept
        .onAppear { if !noted { failure = note; noted = true } }
        .task { if CommandLine.arguments.contains("-typing") { try? await Task.sleep(for: .seconds(1)); focused = true } } // -typing: with the keyboard up
    }

    // Send, while listening or writing down too: listening stops and the words are waited for first, as Add in Quick Add
    private func submit() async {
        guard !dictation.settling, await dictation.settled(into: $text) else { return }
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return }
        text = ""; focused = false; sending = true
        do { let warning = try await send(words); withAnimation { failure = warning } }
        catch {
            text = text.isEmpty ? words : words + "\n\n" + text // the unsent words come back, ahead of anything typed since
            withAnimation { failure = error.localizedDescription }
        }
        sending = false
    }
}
