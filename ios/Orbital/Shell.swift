import SwiftUI

// The app's frame, after the Codex and ChatGPT apps: a side menu behind the page (Timeline and Searches, search and
// settings), the page with its title between the menu and search buttons, and a composer at the bottom that will start
// a new Codex thread (#665). The bars are the system's, so they are Liquid Glass with nothing of ours drawn over them.
struct Shell: View {
    let engine: Engine
    enum Page: String { case timeline = "Timeline", searches = "Searches" }

    @State private var page = Page.timeline
    @State private var menu = false
    @State private var settings = false
    @State private var searching = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let width: CGFloat = 300

    var body: some View {
        ZStack(alignment: .leading) {
            SideMenu(page: $page, close: { show(false) }, search: { show(false); searching = true }, settings: { settings = true })
                .frame(width: width)
                .accessibilityHidden(!menu)
            NavigationStack {
                Group {
                    switch page {
                    case .timeline: TimelineScreen(engine: engine)
                    case .searches:
                        ContentUnavailableView("Saved searches", image: "Glyphs/library", description: Text("The searches you pin in Orbital will be here."))
                    }
                }
                .navigationTitle(page.rawValue)
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
            // pushed aside, the page is a card of clear Liquid Glass over its content, as the ChatGPT app's is; a tap closes it
            .overlay {
                if menu {
                    RoundedRectangle(cornerRadius: 44, style: .continuous).fill(.clear)
                        .glassEffect(.clear, in: RoundedRectangle(cornerRadius: 44, style: .continuous))
                        .ignoresSafeArea()
                        .contentShape(Rectangle())
                        .onTapGesture { show(false) }
                        .accessibilityHidden(true)
                }
            }
            .shadow(color: .black.opacity(menu ? 0.3 : 0), radius: 24)
            .offset(x: menu ? width : 0)
            .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded { drag in
                guard abs(drag.translation.height) < 60 else { return }
                if drag.translation.width > 80 { show(true) } else if drag.translation.width < -80 { show(false) }
            })
        }
        .background(Color(.systemBackground))
        .sheet(isPresented: $settings) { SettingsView(engine: engine) }
        .sheet(isPresented: $searching) { SearchSheet(engine: engine) }
    }

    private func show(_ open: Bool) {
        withAnimation(reduceMotion ? nil : .snappy) { menu = open }
    }
}

// The side menu: the app's name with search beside it, its pages, and settings at the foot
struct SideMenu: View {
    @Binding var page: Shell.Page
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
            ForEach([Shell.Page.timeline, .searches], id: \.self) { item in
                Button { page = item; close() } label: {
                    HStack(spacing: 14) {
                        Image(item == .timeline ? "Glyphs/timelineMenu" : "Glyphs/libraryMenu").resizable().frame(width: 22, height: 22)
                        Text(item.rawValue).fontWeight(.medium)
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
}

// The composer, as the Codex app has it: what you type becomes a new chat with Tana. Sending comes next, so for now it
// says so for a moment rather than doing nothing.
struct Composer: View {
    @State private var text = ""
    @State private var notYet = false

    var body: some View {
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        VStack(spacing: 6) {
            if notYet {
                Text("Asking Tana from here comes next.")
                    .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center).transition(.opacity)
            }
            // The words set the capsule's height (a line of body text and 12 pt above and below it: 46 pt), and the send
            // button sits in its bottom-right corner, 6 pt from the edge on three sides whatever the text field measures
            TextField("Ask Tana", text: $text, axis: .vertical).lineLimit(1...5)
                .padding(.leading, 18)
                .padding(.trailing, 52)
                .padding(.vertical, 12)
                .overlay(alignment: .bottomTrailing) {
                    Button {
                        withAnimation { notYet = true }
                        Task { try? await Task.sleep(for: .seconds(4)); withAnimation { notYet = false } }
                    } label: {
                        // the Codex app's send: a grey circle while there is nothing to send, solid once there is
                        Image(systemName: "arrow.up").font(.body.weight(.semibold))
                            .foregroundStyle(empty ? AnyShapeStyle(.tertiary) : AnyShapeStyle(Color(.systemBackground)))
                            .frame(width: 34, height: 34)
                            .background(Circle().fill(empty ? AnyShapeStyle(.fill.tertiary) : AnyShapeStyle(.primary)))
                    }
                    .buttonStyle(.plain)
                    .disabled(empty)
                    .accessibilityLabel("Ask Tana")
                    .padding(6)
                }
                .glassEffect(.regular.interactive(), in: .capsule)
        }
        .padding(.horizontal, 36) // inset as the Codex app's composer is, not edge to edge
        .padding(.bottom, 4)
    }
}

// Search over Tana from the top bar or the menu: Tana's own text search, newest change first; a result opens in Tana
struct SearchSheet: View {
    let engine: Engine
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var text = ""
    @State private var found: [Engine.Found] = []
    @State private var asked = ""

    var body: some View {
        NavigationStack {
            List(found) { item in
                Button { Task { if let url = await engine.link(item.id) { openURL(url) } } } label: {
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
    static func glyph(_ item: Engine.Found) -> String {
        switch item.kind {
        case "event": "calendar"
        case "space": "space"
        case "user-profile": "member"
        case "chat": "discuss"
        default: item.state != nil ? "task" : "doc"
        }
    }
}
