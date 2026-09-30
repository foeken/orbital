import SwiftUI
import UserNotifications

@main
struct OrbitalApp: App {
    @UIApplicationDelegateAdaptor(Pushes.self) private var pushes // Observable: SwiftUI puts it in the environment
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

// Push from the Mac (#663): the phone asks for notifications once signed in, hands Apple's device token to the engine,
// which writes it into Orbital's settings document, and every Mac running Orbital sends its banners here too
// (main/push.js). A push shows while the app is open as well; a tap opens its node (the shell watches opened).
@MainActor @Observable
final class Pushes: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var token: String?
    var opened: String? // the node of the push last tapped, until the shell has opened it

    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self // before launch ends, so a tap that launched the app is heard
        return true
    }

    func ask() async {
        guard (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) == true else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        token = deviceToken.map { String(format: "%02x", $0) }.joined()
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let id = response.notification.request.content.userInfo["id"] as? String
        await MainActor.run { opened = id }
    }

    // Which of Apple's two push services this build's token belongs to: a development-signed build (Sqim's) carries
    // aps-environment development in its profile and gets sandbox pushes; the App Store's carries no profile at all
    static let environment: String = {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let profile = try? String(contentsOf: url, encoding: .isoLatin1),
              let match = profile.firstMatch(of: /aps-environment<\/key>\s*<string>(\w+)</) else { return "production" }
        return match.1 == "development" ? "sandbox" : "production"
    }()
}

struct ContentView: View {
    @State private var engine = Engine()
    @State private var details = false
    @Environment(\.scenePhase) private var scene
    @Environment(Pushes.self) private var pushes

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
        .onChange(of: scene) { if scene == .active { Task { await engine.refresh() } } }
        // once signed in: ask for notifications, and write this phone's token into the settings document when Apple gives it
        .task(id: engine.phase == .ready) { if engine.phase == .ready, !CommandLine.arguments.contains("-sample") { await pushes.ask() } } // the sample registers nothing
        .task(id: [engine.phase == .ready ? "ready" : "", pushes.token ?? ""]) {
            if engine.phase == .ready, let token = pushes.token { await engine.registerPush(token, environment: Pushes.environment) }
        }
    }
}

// What sign-in did, to copy or share when it goes wrong (#658); shown in a sheet or pushed from Settings
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
