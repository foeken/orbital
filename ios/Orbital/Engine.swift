import SwiftUI
import WebKit

// The app's only link to Tana: one web view, hidden on https://home.tana.inc/api/auth/session running engine.js, which is
// Orbital's own SDK and main/timeline.js bundled for the phone (ios/engine, issue #658). Same-origin there, the SDK
// uses the web view's login cookies as Tana's own client does. Signed out, the same web view shows Tana's sign-in, so
// the session lands where the engine reads it.
@MainActor @Observable
final class Engine: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    enum Phase: Equatable { case starting, signedOut, ready, failed(String) }

    var phase = Phase.starting
    var rows: [Row] = []
    var loading = false
    var error: String?
    var pages = 1
    var diagnosis: String? // while signing in: what the app sees of Tana's session, names only (#658)
    @ObservationIgnored let web: WKWebView
    @ObservationIgnored private var watch: Task<Void, Never>?
    @ObservationIgnored private var justSignedIn = false

    static let session = URL(string: "https://home.tana.inc/api/auth/session")!
    static let home = URL(string: "https://home.tana.inc")!
    // Google and others refuse sign-in in a web view that does not say it is Safari
    static let safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        if let url = Bundle.main.url(forResource: "engine", withExtension: "js"), let source = try? String(contentsOf: url, encoding: .utf8) {
            config.userContentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        web = WKWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.add(self, name: "orbital") // held for the app's life, as the engine is
        web.customUserAgent = Self.safari
        web.isInspectable = true
        web.navigationDelegate = self
        Task {
            await SavedSession.restore(into: web.configuration.websiteDataStore.httpCookieStore)
            start()
        }
    }

    func start() {
        watch?.cancel()
        phase = .starting
        web.load(URLRequest(url: Self.session, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData))
    }

    // engine.js says 'ready' once it is loaded on the session page
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.body as? String == "ready" else { return }
        Task { await connect() }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard phase != .signedOut else { return } // Tana's own pages handle their own errors
        phase = .failed(error.localizedDescription)
    }

    private func connect() async {
        do {
            if try await web.callAsyncJavaScript("return await orbital.connect()", contentWorld: .page) as? Bool == true {
                justSignedIn = false
                phase = .ready
                await refresh()
            } else if justSignedIn {
                // Tana said signed in a moment ago: say so, rather than showing its sign-in again and again
                justSignedIn = false
                phase = .failed("You signed in to Tana, but Orbital could not read the session. Try again.")
            } else {
                signIn()
            }
        } catch {
            phase = .failed(Self.message(error))
        }
    }

    // Tana's own sign-in in this web view; signed in is what Tana's session says, asked every two seconds as the
    // desktop's login window does (tana-session.js login)
    private func signIn() {
        phase = .signedOut
        web.load(URLRequest(url: Self.home))
        watch = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard phase == .signedOut else { continue }
                let cookies = await web.configuration.websiteDataStore.httpCookieStore.allCookies().filter { $0.domain.hasSuffix("tana.inc") }.map(\.name).sorted()
                let host = web.url?.host ?? "none"
                guard host == "home.tana.inc" else { diagnosis = "\(host) · cookies: \(cookies.joined(separator: ", "))"; continue }
                var answer = "no answer"
                do {
                    answer = try await web.callAsyncJavaScript(
                        "const r = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' }); const j = await r.json().catch(() => ({})); return r.status + ' ' + (j.authenticated === true ? 'signed in' : 'signed out')",
                        contentWorld: .page) as? String ?? answer
                } catch {
                    answer = Self.message(error)
                }
                diagnosis = "\(host)\(web.url?.path ?? "") · session \(answer) · cookies: \(cookies.joined(separator: ", "))"
                if answer.hasSuffix(" signed in"), !Task.isCancelled {
                    justSignedIn = true
                    start()
                    return
                }
            }
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
            await SavedSession.save(from: web.configuration.websiteDataStore.httpCookieStore) // Tana rotates the session: keep the newest
        } catch {
            let message = Self.message(error)
            if message.contains("not authenticated") { signIn() } // the session ran out: sign in again
            self.error = message
        }
    }

    func more() async {
        pages += 1
        await refresh()
    }

    func link(_ id: String) async -> URL? {
        let s = try? await web.callAsyncJavaScript("return orbital.link(id)", arguments: ["id": id], contentWorld: .page) as? String
        return s.flatMap(URL.init(string:))
    }

    // what engine.js threw, rather than WebKit's "A JavaScript exception occurred"
    private static func message(_ error: Error) -> String {
        (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription
    }
}

// Tana's cookies (the __session on home.tana.inc lasts seven days) kept in the Keychain as well: WebKit writes cookies to
// disk when it gets round to it, and the app closed right after signing in lost the sign-in. Restored only when WebKit
// has none, so a session Tana rotated since is never overwritten by an older one.
@MainActor
enum SavedSession {
    private static let item: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: "com.dreetje.orbital", kSecAttrAccount: "tana-cookies"]
    private static func isTana(_ c: HTTPCookie) -> Bool { c.domain.hasSuffix("tana.inc") }

    static func save(from store: WKHTTPCookieStore) async {
        guard let data = encode(await store.allCookies().filter(isTana)) else { return }
        SecItemDelete(item as CFDictionary)
        var add = item
        add[kSecValueData] = data
        add[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    static func restore(into store: WKHTTPCookieStore) async {
        guard !(await store.allCookies()).contains(where: { isTana($0) && $0.name == "__session" }) else { return }
        var query = item
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return }
        for cookie in decode(data) { await store.setCookie(cookie) }
    }

    nonisolated static func encode(_ cookies: [HTTPCookie]) -> Data? {
        let list = cookies.compactMap { $0.properties.map { Dictionary(uniqueKeysWithValues: $0.map { ($0.key.rawValue, $0.value) }) } }
        return list.isEmpty ? nil : try? PropertyListSerialization.data(fromPropertyList: list, format: .binary, options: 0)
    }

    nonisolated static func decode(_ data: Data) -> [HTTPCookie] {
        let list = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [[String: Any]] ?? []
        return list.compactMap { HTTPCookie(properties: Dictionary(uniqueKeysWithValues: $0.map { (HTTPCookiePropertyKey($0.key), $0.value) })) }
            .filter { ($0.expiresDate ?? .distantFuture) > .now }
    }
}

struct WebHost: UIViewRepresentable {
    let web: WKWebView
    func makeUIView(context: Context) -> WKWebView { web }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
