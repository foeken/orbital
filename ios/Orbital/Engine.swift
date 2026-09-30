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
    var email: String? // the Tana account signed in, for Settings
    var states: [String: String] = [:] // task id -> the stateType ticked here, until a read of Tana agrees with it
    // What sign-in and the session did, newest last, for Details: cookie names only, never a value (#658). A line is
    // added only when it differs from the one before, so the screen is redrawn only when something moved.
    var log: [String] = []
    @ObservationIgnored let web: WKWebView
    @ObservationIgnored private var watch: Task<Void, Never>?
    @ObservationIgnored private var justSignedIn = false

    static let session = URL(string: "https://home.tana.inc/api/auth/session")!
    static let home = URL(string: "https://home.tana.inc")!
    // -sample: invented content in place of Tana (timeline-sample.json, pages-sample.json), for design shots; writes nothing
    static let isSample = CommandLine.arguments.contains("-sample")
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
        if Self.isSample { showSample(); return }
        Task {
            await SavedSession.restore(into: web.configuration.websiteDataStore.httpCookieStore)
            start()
        }
    }

    func start() {
        guard !Self.isSample else { return }
        watch?.cancel()
        phase = .starting
        note("loading the session page")
        web.load(URLRequest(url: Self.session, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData))
    }

    func note(_ line: String) {
        guard log.last?.dropFirst(9) != line[...] else { return }
        log.append(Date.now.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).second(.twoDigits)) + " " + line)
        if log.count > 100 { log.removeFirst() }
    }

    // engine.js says 'ready' once it is loaded on the session page
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.body as? String == "ready" else { return }
        Task { await connect() }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        note("load failed: \(error.localizedDescription)")
        guard phase != .signedOut else { return } // Tana's own pages handle their own errors
        phase = .failed(error.localizedDescription)
    }

    // home.tana.inc claims every path for Tana's own app (its apple-app-site-association: "NOT /view/*", "*"), so a
    // plain .allow let iOS hand Tana's sign-in callback to that app and cut this load off ("Frame load interrupted"):
    // the __session cookie never landed and the Tana app opened instead (#658). WebKit's allow-without-trying-app-link
    // (WKNavigationActionPolicyAllow + 2, as Firefox for iOS uses it) keeps every page in this web view.
    static let allowHere = WKNavigationActionPolicy(rawValue: WKNavigationActionPolicy.allow.rawValue + 2) ?? .allow

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        Self.allowHere
    }

    private func connect() async {
        do {
            let ok = try await web.callAsyncJavaScript("return await orbital.connect()", contentWorld: .page) as? Bool == true
            note("engine: session " + ((try? await web.callAsyncJavaScript("return orbital.why()", contentWorld: .page) as? String) ?? "?"))
            if ok {
                justSignedIn = false
                email = try? await web.callAsyncJavaScript("return orbital.email()", contentWorld: .page) as? String
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
            note("engine failed: \(Self.message(error))")
            phase = .failed(Self.message(error))
        }
    }

    // Tana's own sign-in in this web view; signed in is what Tana's session says, asked every two seconds as the
    // desktop's login window does (tana-session.js login)
    private func signIn() {
        watch?.cancel() // a session that ran out mid-refresh comes here with the last watch perhaps still going
        phase = .signedOut
        note("showing Tana's sign-in")
        web.load(URLRequest(url: Self.home))
        watch = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard phase == .signedOut else { continue }
                let cookies = await web.configuration.websiteDataStore.httpCookieStore.allCookies().filter { $0.domain.hasSuffix("tana.inc") }.map(\.name).sorted()
                let host = web.url?.host ?? "none"
                guard host == "home.tana.inc" else { note("\(host) · cookies: \(cookies.joined(separator: ", "))"); continue }
                var answer = "no answer"
                do {
                    answer = try await web.callAsyncJavaScript(
                        "const r = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' }); const j = await r.json().catch(() => ({})); return r.status + ' ' + (j.authenticated === true ? 'signed in' : 'signed out' + (j.reason ? ' (' + j.reason + ')' : ''))",
                        contentWorld: .page) as? String ?? answer
                } catch {
                    answer = Self.message(error)
                }
                note("\(host)\(web.url?.path ?? "") · session \(answer) · cookies: \(cookies.joined(separator: ", "))")
                if answer.hasSuffix(" signed in"), !Task.isCancelled {
                    justSignedIn = true
                    start()
                    return
                }
            }
        }
    }

    func refresh() async {
        guard phase == .ready, !loading, !Self.isSample else { return }
        loading = true
        defer { loading = false }
        do {
            rows = try await call("return await orbital.timeline(pages)", ["pages": pages])
            error = nil
            settle(rows)
            for issue in (try? await web.callAsyncJavaScript("return orbital.issues()", contentWorld: .page)) as? [String] ?? [] { note(issue) }
            await SavedSession.save(from: web.configuration.websiteDataStore.httpCookieStore) // Tana rotates the session: keep the newest
        } catch {
            if error.localizedDescription.contains("not authenticated") { signIn() } // the session ran out: sign in again
            self.error = error.localizedDescription
        }
    }

    func more() async {
        pages += 1
        await refresh()
    }

    // Settings' Sign out: Tana's cookies go from WebKit and the Keychain, and the page starts over at Tana's sign-in
    func signOut() async {
        let store = web.configuration.websiteDataStore.httpCookieStore
        for cookie in await store.allCookies() where cookie.domain.hasSuffix("tana.inc") { await store.deleteCookie(cookie) }
        SavedSession.forget()
        rows = []; states = [:]; email = nil; pages = 1
        note("signed out")
        start()
    }

    // Your saved searches, those pinned to your sidebar first (orbital.searches)
    func searches() async throws -> [Row] {
        if let s = Self.sample { return s.searches }
        return try await call("return await orbital.searches()", [:])
    }

    // A node zoomed into (orbital.open): its title, its kind and what it holds
    struct Page: Decodable { let title: String; let kind: String; let rows: [Row] }
    func open(_ id: String) async throws -> Page {
        if let s = Self.sample { if let page = s.pages[id] { return page }; throw Failure(errorDescription: "Not in the sample") }
        let page: Page = try await call("return await orbital.open(id)", ["id": id])
        settle(page.rows) // a search's tasks ticked here, once Tana agrees
        return page
    }

    // Ask Tana (orbital.ask): a new chat with what you typed as its first message; answers the chat's id
    func ask(_ text: String) async throws -> String {
        if Self.isSample { return "tana:chat:000000000000000000000000c1" }
        return try await call("return JSON.stringify(await orbital.ask(text))", ["text": text])
    }
    // a follow-up in a chat (orbital.send)
    func send(_ text: String, to id: String) async throws {
        if Self.isSample { return }
        let _: String = try await call("return JSON.stringify(await orbital.send(id, text))", ["id": id, "text": text])
    }

    struct Failure: LocalizedError { let errorDescription: String? }
    private func call<T: Decodable>(_ js: String, _ arguments: [String: Any]) async throws -> T {
        do {
            let json = try await web.callAsyncJavaScript(js, arguments: arguments, contentWorld: .page) as? String ?? "null"
            return try JSONDecoder().decode(T.self, from: Data(json.utf8))
        } catch {
            note("\(js.firstMatch(of: /orbital\.(\w+)/)?.1 ?? "engine") failed: \(Self.message(error))")
            throw Failure(errorDescription: Self.message(error))
        }
    }

    // -sample: pages-sample.json in place of Tana for these pages, invented content only
    private struct Sample: Decodable { let searches: [Row]; let pages: [String: Page] }
    private static let sample: Sample? = isSample
        ? Bundle.main.url(forResource: "pages-sample", withExtension: "json").flatMap { try? JSONDecoder().decode(Sample.self, from: Data(contentsOf: $0)) } : nil

    // A task's box: drawn in its new state at once, written by engine.js (orbital.toggle, the desktop's rule), and put
    // back with the reason in Details if Tana refuses. The row stays where it is (orbital-design: never move things
    // under the user); the next read confirms it.
    func toggle(_ task: Row) async {
        let before = state(of: task)
        states[task.id] = before == "proposed" || before == "closed" ? "open" : "closed"
        guard !Self.isSample else { return } // the sample writes nothing
        do {
            states[task.id] = try await call("return await orbital.toggle(id)", ["id": task.id]) as String
        } catch {
            states[task.id] = before
            self.error = error.localizedDescription
        }
    }

    func state(of task: Row) -> String {
        states[task.id] ?? task.stateType ?? (task.done == true ? "closed" : "open")
    }

    // the boxes ticked here that Tana now shows as ticked go back to reading Tana
    private func settle(_ rows: [Row]) { states = states.filter { id, state in Self.stateType(id, in: rows) != state } }

    private static func stateType(_ id: String, in rows: [Row]) -> String? {
        for row in rows {
            if row.id == id { return row.stateType }
            if let found = stateType(id, in: row.children ?? []) { return found }
        }
        return nil
    }

    // Launched with -sample: timeline-sample.json in place of Tana, for screenshots of the design. Invented content only;
    // its times are minutes from now ("{{min:-40}}", "{{ms:+44}}") so the page always reads as today's.
    private func showSample() {
        guard let url = Bundle.main.url(forResource: "timeline-sample", withExtension: "json"), var json = try? String(contentsOf: url, encoding: .utf8) else { return }
        for match in json.matches(of: /"\{\{(min|ms):([+-]?\d+)\}\}"/).reversed() {
            let at = Date.now.addingTimeInterval(Double(match.2)! * 60)
            json.replaceSubrange(match.range, with: match.1 == "ms" ? String(Int(at.timeIntervalSince1970 * 1000)) : "\"" + at.ISO8601Format(.iso8601.year().month().day().time(includingFractionalSeconds: true)) + "\"")
        }
        rows = (try? JSONDecoder().decode([Row].self, from: Data(json.utf8))) ?? []
        // -history: the day's entries only, so a shot of them needs no scrolling
        if CommandLine.arguments.contains("-history") { rows.removeAll { $0.timeline?.today == true || $0.timeline?.upcoming == true || $0.timeline?.free != nil } }
        phase = .ready
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
    private static let account = "tana-cookies"
    private static func isTana(_ c: HTTPCookie) -> Bool { c.domain.hasSuffix("tana.inc") }

    static func save(from store: WKHTTPCookieStore) async {
        if let data = encode(await store.allCookies().filter(isTana)) { Keychain.save(data, account) }
    }
    static func forget() { Keychain.delete(account) }

    static func restore(into store: WKHTTPCookieStore) async {
        guard !(await store.allCookies()).contains(where: { isTana($0) && $0.name == "__session" }) else { return }
        guard let data = Keychain.load(account) else { return }
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

// What the app keeps secret, on this phone only (never synced, never in a backup to another device)
enum Keychain {
    private static func item(_ account: String) -> [CFString: Any] { [kSecClass: kSecClassGenericPassword, kSecAttrService: "com.dreetje.orbital", kSecAttrAccount: account] }

    static func save(_ data: Data, _ account: String) {
        SecItemDelete(item(account) as CFDictionary)
        var add = item(account)
        add[kSecValueData] = data
        add[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    static func load(_ account: String) -> Data? {
        var query = item(account)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var out: CFTypeRef?
        return SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    static func delete(_ account: String) { SecItemDelete(item(account) as CFDictionary) }
}

struct WebHost: UIViewRepresentable {
    let web: WKWebView
    func makeUIView(context: Context) -> WKWebView { web }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
