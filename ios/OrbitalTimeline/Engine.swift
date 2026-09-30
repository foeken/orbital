import SwiftUI
import WebKit

// The app's only link to Tana: a hidden web view on https://home.tana.inc/api/auth/session running engine.js, which is
// Orbital's own SDK and main/timeline.js bundled for the phone (ios/engine, issue #658). Same-origin there, the SDK
// uses the web view's login cookies as Tana's own client does; this asks it for rows and draws nothing itself.
@MainActor @Observable
final class Engine: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    enum Phase: Equatable { case starting, signedOut, ready, failed(String) }

    var phase = Phase.starting
    var rows: [Row] = []
    var loading = false
    var error: String?
    var pages = 1
    @ObservationIgnored let web: WKWebView

    static let session = URL(string: "https://home.tana.inc/api/auth/session")!
    // Google and others refuse sign-in in a web view that does not say it is Safari
    static let safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

    override init() {
        let config = WKWebViewConfiguration()
        if let url = Bundle.main.url(forResource: "engine", withExtension: "js"), let source = try? String(contentsOf: url, encoding: .utf8) {
            config.userContentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        web = WKWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.add(self, name: "orbital") // held for the app's life, as the engine is
        web.customUserAgent = Self.safari
        web.navigationDelegate = self
        start()
    }

    func start() {
        phase = .starting
        web.load(URLRequest(url: Self.session))
    }

    // engine.js says 'ready' once it is loaded on the session page
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.body as? String == "ready" else { return }
        Task { await connect() }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        phase = .failed(error.localizedDescription)
    }

    private func connect() async {
        do {
            let ok = try await web.callAsyncJavaScript("return await orbital.connect()", contentWorld: .page) as? Bool ?? false
            phase = ok ? .ready : .signedOut
            if ok { await refresh() }
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    func refresh() async {
        guard phase == .ready, !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let json = try await web.callAsyncJavaScript("return await orbital.timeline(pages)", arguments: ["pages": pages], contentWorld: .page) as? String ?? "[]"
            rows = try JSONDecoder().decode([Row].self, from: Data(json.utf8))
            error = nil
        } catch {
            let message = Self.message(error)
            if message.contains("not authenticated") { phase = .signedOut } // the session ran out: sign in again
            self.error = message
        }
    }

    // what engine.js threw, rather than WebKit's "A JavaScript exception occurred"
    private static func message(_ error: Error) -> String {
        (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription
    }

    func more() async {
        pages += 1
        await refresh()
    }

    func link(_ id: String) async -> URL? {
        let s = try? await web.callAsyncJavaScript("return orbital.link(id)", arguments: ["id": id], contentWorld: .page) as? String
        return s.flatMap(URL.init(string:))
    }
}

struct WebHost: UIViewRepresentable {
    let web: WKWebView
    func makeUIView(context: Context) -> WKWebView { web }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

// Tana's own sign-in (WorkOS), in a web view sharing the engine's cookie store. Signed in is what Tana's session says,
// asked every two seconds as the desktop's login window does (tana-session.js login).
struct SignInView: UIViewRepresentable {
    let done: () -> Void

    func makeUIView(context: Context) -> WKWebView {
        let web = WKWebView()
        web.customUserAgent = Engine.safari
        web.load(URLRequest(url: URL(string: "https://home.tana.inc")!))
        context.coordinator.watch(web, done)
        return web
    }
    func updateUIView(_ view: WKWebView, context: Context) {}
    func makeCoordinator() -> Watch { Watch() }
    static func dismantleUIView(_ view: WKWebView, coordinator: Watch) { coordinator.task?.cancel() }

    @MainActor final class Watch {
        var task: Task<Void, Never>?
        func watch(_ web: WKWebView, _ done: @escaping () -> Void) {
            task = Task { [weak web] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(2))
                    guard let web, web.url?.host == "home.tana.inc" else { continue }
                    let signedIn = try? await web.callAsyncJavaScript(
                        "const r = await fetch('/api/auth/session', { credentials: 'include' }); return (await r.json()).authenticated === true",
                        contentWorld: .page) as? Bool
                    if signedIn == true { done(); return }
                }
            }
        }
    }
}
