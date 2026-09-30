import SwiftUI

@main
struct OrbitalTimelineApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

struct ContentView: View {
    @State private var engine = Engine()
    @Environment(\.scenePhase) private var scene

    var body: some View {
        ZStack {
            // the engine's web view has to be in a window to keep running; nobody sees it
            WebHost(web: engine.web).frame(width: 1, height: 1).opacity(0).allowsHitTesting(false).accessibilityHidden(true)
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
                }
            case .signedOut:
                NavigationStack {
                    SignInView { engine.start() }
                        .ignoresSafeArea(edges: .bottom)
                        .navigationTitle("Sign in to Tana")
                        .navigationBarTitleDisplayMode(.inline)
                }
            case .ready:
                TimelineScreen(engine: engine)
            }
        }
        .onChange(of: scene) { if scene == .active { Task { await engine.refresh() } } }
    }
}

