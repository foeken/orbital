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
                Shell(engine: engine)
            }
        }
        .sheet(isPresented: $details) { NavigationStack { SignInLog(lines: engine.log) } }
        // a shake shows what is sensitive, and the next one hides it again
        .onReceive(NotificationCenter.default.publisher(for: .shake)) { _ in withAnimation { engine.reveal.toggle() } }
        .sensoryFeedback(.impact, trigger: engine.reveal)
        .onChange(of: scene) { if scene == .active { Task { await engine.refresh() } } }
    }
}

// What sign-in did, to copy or share when it goes wrong (#658), from the sign-in screen's Details
struct SignInLog: View {
    let lines: [String]
    var body: some View {
        let text = lines.joined(separator: "\n")
        ScrollView {
            Text(text.isEmpty ? "Nothing yet." : text).font(.footnote.monospaced()).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading).padding()
        }
        .navigationTitle("Sign-in details")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ShareLink(item: text) }
    }
}

// The shake gesture: iOS tells the window, which says so to the app (ContentView)
extension Notification.Name { static let shake = Notification.Name("orbital.shake") }
extension UIWindow {
    open override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        if motion == .motionShake { NotificationCenter.default.post(name: .shake, object: nil) }
        super.motionEnded(motion, with: event)
    }
}
