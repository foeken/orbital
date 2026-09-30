import SwiftUI

@main
struct OrbitalApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

struct ContentView: View {
    @State private var engine = Engine()
    @Environment(\.scenePhase) private var scene

    var body: some View {
        let signingIn = engine.phase == .signedOut
        ZStack {
            // one web view in one place: Tana's sign-in while signed out, hidden behind the app once the engine runs
            VStack(spacing: 0) {
                if signingIn { Text("Sign in to Tana").font(.headline).padding(.vertical, 12) }
                WebHost(web: engine.web).ignoresSafeArea(edges: .bottom)
                if signingIn, let diagnosis = engine.diagnosis {
                    Text(diagnosis).font(.caption2).foregroundStyle(.secondary).lineLimit(3).padding(8).frame(maxWidth: .infinity).background(.bar)
                }
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
                }
            case .signedOut:
                EmptyView()
            case .ready:
                TimelineScreen(engine: engine)
            }
        }
        .onChange(of: scene) { if scene == .active { Task { await engine.refresh() } } }
    }
}
