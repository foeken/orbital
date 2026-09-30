import SwiftUI

@main
struct OrbitalApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

struct ContentView: View {
    @State private var engine = Engine()
    @State private var details = false
    @Environment(\.scenePhase) private var scene

    var body: some View {
        let signingIn = engine.phase == .signedOut
        ZStack {
            // one web view in one place: Tana's sign-in while signed out, hidden behind the app once the engine runs
            VStack(spacing: 0) {
                if signingIn {
                    Text("Sign in to Tana").font(.headline).padding(.vertical, 12).frame(maxWidth: .infinity)
                        .overlay(alignment: .trailing) { Button("Details") { details = true }.font(.subheadline).padding(.trailing) }
                }
                WebHost(web: engine.web).ignoresSafeArea(edges: .bottom)
            }
            .opacity(signingIn ? 1 : 0)
            .allowsHitTesting(signingIn)
            .accessibilityHidden(!signingIn)
            switch engine.phase {
            case .starting:
                ProgressView("Connecting to Tana…")
            case .failed(let message):
                ContentUnavailableView {
                    Label("Can't reach Tana", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try again") { engine.start() }.buttonStyle(.borderedProminent)
                    Button("Details") { details = true }
                }
            case .signedOut:
                EmptyView()
            case .ready:
                Tabs(engine: engine)
            }
        }
        .sheet(isPresented: $details) { SignInLog(lines: engine.log) }
        .onChange(of: scene) { if scene == .active { Task { await engine.refresh() } } }
    }
}

// The bottom bar: the system TabView, which is Liquid Glass on iOS 26 and later with nothing of ours drawn over it, and
// shrinks out of the way on scroll. The Timeline first; saved searches and search are placeholders until #662.
struct Tabs: View {
    let engine: Engine

    var body: some View {
        TabView {
            Tab("Timeline", image: "Glyphs/timeline") { TimelineScreen(engine: engine) }
            Tab("Searches", image: "Glyphs/library") {
                NavigationStack {
                    ContentUnavailableView("Saved searches", image: "Glyphs/library", description: Text("The searches you pin in Orbital will be here, each as a tab you can choose."))
                        .navigationTitle("Searches")
                }
            }
            Tab(role: .search) {
                NavigationStack {
                    ContentUnavailableView("Search", systemImage: "magnifyingglass", description: Text("Searching Tana from here comes next."))
                        .navigationTitle("Search")
                }
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
    }
}
// What sign-in did, to copy or share when it goes wrong (#658)
struct SignInLog: View {
    let lines: [String]
    var body: some View {
        let text = lines.joined(separator: "\n")
        NavigationStack {
            ScrollView {
                Text(text.isEmpty ? "Nothing yet." : text).font(.footnote.monospaced()).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding()
            }
            .navigationTitle("Sign-in details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ShareLink(item: text) }
        }
    }
}
