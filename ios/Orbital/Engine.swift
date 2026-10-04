import Security
import SwiftUI
import WebKit
import WidgetKit

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
    @ObservationIgnored private var ticked: [String: Date] = [:] // task id -> when it was ticked here
    // What sign-in and the session did, newest last, for Details: cookie names only, never a value (#658). A line is
    // added only when it differs from the one before, so the screen is redrawn only when something moved.
    var log: [String] = []
    let translator = Translator() // auto-translate, set up from the settings document at each refresh
    var sensitiveIds: Set<String> = [] // marked sensitive in Orbital (synced), for the long-press menu
    var pinned: Set<String> = [] // pinned to a day, any day, for the long-press menu
    var removed: Set<String> = [] // deleted here: gone from every list at once, before Tana confirms it
    var reveal = false // sensitive items shown, after a shake; never kept, as the desktop keeps it on the machine only
    // Settings' Demo mode, as the desktop's: made-up words and names on screen, nothing saved (ios/engine/demo.js); kept on this phone
    var demo = UserDefaults.standard.bool(forKey: "demoMode") {
        didSet {
            UserDefaults.standard.set(demo, forKey: "demoMode")
            partsFor = nil // what a read under way brings is the other mode's
            if demo, !Self.isSample { rows = [] } // the real words go at once, rather than staying until the masked read lands, or for good with Tana out of reach
            Task { await refresh() }
        }
    }
    @ObservationIgnored let web: WKWebView
    @ObservationIgnored private var watch: Task<Void, Never>?
    @ObservationIgnored private var justSignedIn = false
    @ObservationIgnored private var session = 0 // counts sign-outs: a read that began before one never saves or shows what it got
    @ObservationIgnored private var savedFor: String? // whose the saved Timeline on screen is, until Tana says who is signed in
    @ObservationIgnored private var account: String? // who is signed in, in which workspace (orbital.account): what the saved Timeline is kept for
    @ObservationIgnored private var partsFor: Int? // the session whose Timeline read is under way, taking its first part (show(part:))

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
        #if DEBUG
        web.isInspectable = true // Safari's Web Inspector; never in a release, where the page holds a live Tana token
        #endif
        web.navigationDelegate = self
        if Self.isSample { showSample(); return }
        // the last Timeline read, on screen at once while Tana connects (SavedTimeline); never in demo mode
        if !demo, let saved = SavedTimeline.load() { rows = saved.rows; savedFor = saved.account }
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

    // engine.js says 'ready' once it is loaded on the session page, 'changed' when the Timeline moved under it, and
    // 'part:' with the first rows of a Timeline read still under way
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if let said = message.body as? String, said.hasPrefix("part:") { show(part: String(said.dropFirst(5))); return }
        if message.body as? String == "changed" { Task { await refresh() }; return }
        guard message.body as? String == "ready" else { return }
        Task { await connect() }
    }

    // A page that never started: offline, or Tana unreachable, sign-in included, where no page of Tana's is there to say so.
    // A load cut off on purpose is not one (a redirect replacing it, WebKit's "Frame load interrupted" as sign-in hands over).
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        note("load failed: \(error.localizedDescription)")
        let e = error as NSError
        guard !(e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled), !(e.domain == "WebKitErrorDomain" && e.code == 102) else { return }
        watch?.cancel()
        fail(error.localizedDescription)
    }

    // Tana out of reach, or a session that could not be read: said in place of the app, or under the saved Timeline when
    // one is on screen (ContentView), where pulling it or coming back to the app tries again (refresh)
    private func fail(_ message: String) {
        phase = .failed(message)
        error = message
    }

    // home.tana.inc claims every path for Tana's own app (its apple-app-site-association: "NOT /view/*", "*"), so a
    // plain .allow let iOS hand Tana's sign-in callback to that app and cut this load off ("Frame load interrupted"):
    // the __session cookie never landed and the Tana app opened instead (#658). WebKit's allow-without-trying-app-link
    // (WKNavigationActionPolicyAllow + 2, as Firefox for iOS uses it) keeps every page in this web view.
    // ponytail: a private WebKit value, fine for these development builds; an App Store build needs another way (#658).
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
                let was = savedFor ?? account // whose rows are on screen: the saved Timeline's, or the session's before this one ran out
                account = try? await web.callAsyncJavaScript("return orbital.account()", contentWorld: .page) as? String
                if let was, was != account { rows = []; SavedTimeline.forget() } // another account's, or another workspace's: off the screen and off the phone
                savedFor = nil
                // the cookies kept at once, as the refresh may not finish, and beside it: the Timeline waits on no Keychain
                Task { await SavedSession.save(from: web.configuration.websiteDataStore.httpCookieStore) }
                phase = .ready
                await refresh()
            } else if justSignedIn {
                // Tana said signed in a moment ago: say so, rather than showing its sign-in again and again
                justSignedIn = false
                fail("You signed in to Tana, but Orbital could not read the session. Try again.")
            } else {
                signIn()
            }
        } catch {
            note("engine failed: \(Self.message(error))")
            fail(Self.message(error))
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

    // A change told while a read is under way is not lost: one more read follows it, however many came
    @ObservationIgnored private var again = false
    func refresh() async {
        if case .failed = phase, !rows.isEmpty { start(); return } // the saved Timeline on screen, Tana out of reach: try again
        guard phase == .ready, !Self.isSample else { return }
        guard !loading else { again = true; return }
        loading = true
        await read()
        loading = false
        if again { again = false; await refresh() }
    }

    private func read() async {
        let started = session, masked = demo
        partsFor = session
        defer { partsFor = nil }
        do {
            let (read, json): ([Row], String) = try await call("return await orbital.timeline(pages)", ["pages": pages]) {
                (try JSONDecoder().decode([Row].self, from: Data($0.utf8)), $0)
            }
            partsFor = nil // a part told late is older than this
            guard started == session, masked == demo else { return } // signed out meanwhile, or demo mode switched: the read it asked for shows
            rows = read
            if !demo, pages == 1, let account { SavedTimeline.save(json, account: account) } // what the next launch shows first
            error = nil
            settle(rows)
            if let setup: Setup = try? await call("return await orbital.setup()", [:]) {
                translator.use(to: setup.to, ai: setup.ai)
                if translator.catalogue.isEmpty, let list = try? await ChatGPT.models(), !list.isEmpty { translator.catalogue = list } // once: what this account may ask
                sensitiveIds = Set(setup.sensitive); pinned = Set(setup.pinned)
            }
            await keepGlimpse()
            for issue in (try? await web.callAsyncJavaScript("return orbital.issues()", contentWorld: .page)) as? [String] ?? [] { note(issue) }
            await SavedSession.save(from: web.configuration.websiteDataStore.httpCookieStore) // Tana rotates the session: keep the newest
        } catch {
            guard started == session else { return }
            if error.localizedDescription.contains("not authenticated") { signIn() } // the session ran out: sign in again
            self.error = error.localizedDescription
        }
    }

    // The Timeline's first part, Today's Tasks and Upcoming meetings, told while the rest is still read (ios/engine/read.js):
    // it takes the place of the same rows on screen, and the days under them stay until the whole page lands. The last part
    // can be the whole page.
    private func show(part json: String) {
        guard partsFor == session, let part = try? JSONDecoder().decode([Row].self, from: Data(json.utf8)) else { return }
        rows = part.allSatisfy(\.top) ? part + rows.filter { !$0.top } : part
    }

    func more() async {
        guard !loading, phase == .ready else { return } // a second tap while the first is loading would count a page never read
        pages += 1
        await refresh()
    }

    // Settings' Sign out: the engine lets its session lookups finish and closes, then Tana's cookies go from WebKit and the
    // Keychain, and the page starts over at Tana's sign-in. A refresh still under way sees the count move and keeps nothing.
    func signOut() async {
        session += 1
        _ = try? await web.callAsyncJavaScript("await orbital.signOut()", contentWorld: .page)
        let store = web.configuration.websiteDataStore.httpCookieStore
        for cookie in await store.allCookies() where cookie.domain.hasSuffix("tana.inc") { await store.deleteCookie(cookie) }
        SavedSession.forget()
        SavedTimeline.forget()
        Keychain.delete("glimpse") // nothing of the account left on a widget
        Keychain.delete("tasks"); tasksRead = .distantPast // nor for Siri (keepTasks)
        WidgetCenter.shared.reloadAllTimelines()
        await Tasks.index(demo: true) // nor in Spotlight (Intents.swift)
        rows = []; states = [:]; removed = []; email = nil; account = nil; pages = 1
        note("signed out")
        start()
    }

    // Your saved searches, those pinned to your sidebar first (orbital.searches)
    func searches() async throws -> [Row] {
        if let s = Self.sample { return s.searches }
        return try await call("return await orbital.searches()", [:])
    }

    // A node zoomed into (orbital.open): its title, its kind and what it holds
    struct Page: Decodable {
        let title: String
        let kind: String
        let rows: [Row]
        let sensitive: Bool? // the node itself marked sensitive in Orbital: drawn blurred until a shake
    }
    func open(_ id: String) async throws -> Page {
        if let s = Self.sample { if let page = s.pages[id] { return page }; throw Failure(errorDescription: "Not in the sample") }
        let page: Page = try await call("return await orbital.open(id)", ["id": id])
        settle(page.rows) // a search's tasks ticked here, once Tana agrees
        return page
    }

    // What a refresh reads besides the rows (orbital.setup)
    struct Setup: Decodable { let to: String?; let ai: [String: String]; let sensitive: [String]; let pinned: [String] }

    // Long press: Pin to Today and Mark as Sensitive (orbital.pin, orbital.sensitive), then the Timeline read again
    // Remove Pin takes the task out of Today's Tasks at once, collapsing as a deleted row does; the read after says where it
    // is now (still on today's node, it comes back)
    func pin(_ id: String, _ on: Bool) async {
        if !on { withAnimation(Self.collapse) { _ = unpinned.insert(id) } }
        await act("return await orbital.pin(id, on)", ["id": id, "on": on])
        unpinned.remove(id)
    }
    var unpinned: Set<String> = [] // pins being taken off here, out of Today's Tasks before Tana answers
    static var collapse: Animation? { UIAccessibility.isReduceMotionEnabled ? nil : .snappy }
    // Settings' Auto-translate: the synced preference (orbital.translateTo), shown at once and kept if Tana takes it
    func translate(into to: String?) async {
        let was = translator.to
        translator.use(to: to)
        guard !Self.isSample else { return }
        do { let _: String? = try await call("return await orbital.translateTo(to)", ["to": to ?? NSNull()]) } catch { translator.use(to: was); self.error = error.localizedDescription }
    }
    // Settings' Quick and Regular AI: used at once, kept if Tana takes it (orbital.aiChoice), as the Mac's Settings page sets them
    func aiChoice(_ key: String, _ value: String) async {
        let was = translator.ai
        translator.use(to: translator.to, ai: [key: value])
        guard !Self.isSample else { return }
        do { let _: Bool = try await call("return await orbital.aiChoice(key, value)", ["key": key, "value": value]) }
        catch { translator.use(to: translator.to, ai: was); self.error = error.localizedDescription }
    }
    func markSensitive(_ id: String, _ on: Bool) async { await act("return await orbital.sensitive(id, on)", ["id": id, "on": on]) }
    // Long press, Assign to …: the task whose picker is open (AssignSheet), the people to pick from, and the one picked
    struct Assigning: Identifiable { let id: String; let current: [String]?; let then: () async -> Void }
    var assigning: Assigning?
    struct Member: Decodable, Identifiable { let id: String; let name: String }
    func members() async -> [Member] { Self.isSample ? [] : (try? await call("return await orbital.members()", [:])) ?? [] }
    // Someone just assigned who cannot open the task: asked there and then, Grant access or Keep private (renderer/access.js
    // openShareAsk), by the alert Shell lays over everything
    func assign(_ id: String, to uri: String?, then done: @escaping () async -> Void = {}) async {
        guard !Self.isSample else { return }
        do {
            let shut: [String] = try await call("return await orbital.assign(id, uris)", ["id": id, "uris": uri.map { [$0] } ?? []])
            if !shut.isEmpty, let access = await access(id) { asking = .init(id: id, access: access, shut: access.hidden.filter { shut.contains($0.id) }, then: done) }
            await refresh()
        } catch { self.error = error.localizedDescription }
    }
    struct ShareAsk: Identifiable { let id: String; let access: Access; let shut: [Member]; let then: () async -> Void }
    var asking: ShareAsk?

    // A zoomed node's Assigned to and Visible to (orbital.access), and who sees it changed (orbital.share)
    struct Audience: Decodable { let scope: String; let space: String? }
    struct Access: Decodable {
        let title: String, me: String, task: Bool, assignees: [Member]
        let audience: String, space: String?, people: [Member], hidden: [Member]
        let restricted: Bool, participants: [String], rules: [String], reason: String?, inherit: Audience, token: String?
        // Grant access is the pill's write (renderer/access.js hiddenFromFix): only where the node's own list is its audience
        var grants: Bool { restricted && rules.contains("people") }
        // the rule it is shared by now, as the visibility picker ticks it
        var rule: String { !restricted ? "inherit" : participants.isEmpty ? "me" : "people" }
    }
    func access(_ id: String) async -> Access? { Self.isSample ? nil : try? await call("return await orbital.access(id)", ["id": id]) }
    func share(_ id: String, _ rule: String, _ uris: [String] = [], token: String? = nil) async {
        await act("return await orbital.share(id, rule, uris, token)", ["id": id, "rule": rule, "uris": uris, "token": token ?? NSNull()])
    }
    private func act(_ js: String, _ arguments: [String: Any]) async {
        guard !Self.isSample else { return }
        do { let _: Bool = try await call(js, arguments); await refresh() } catch { self.error = error.localizedDescription }
    }

    // Quick Add Task (QuickAdd.swift): the types to pick from, a task made with one, an image made into a task or a note
    struct TaskType: Decodable, Identifiable { let uri: String?; let title: String; var task: Bool? = true; var id: String { uri ?? "" } }
    // a saved search's: the type its rows are and how many of their fields it sets (orbital.searchPreset)
    struct Preset: Decodable { let uri: String; let title: String; let task: Bool; let fields: [String: Value] }
    // Quick Add's fields of a type (orbital.typeFields), a value set in one, and what a person or link field can take
    struct Field: Decodable, Identifiable { let key: String; let title: String; let kind: String; let options: [String]; var id: String { key } }
    struct Value: Decodable, Equatable { var ref: String?; var label: String?; var text: String?
        var json: [String: String] { ["ref": ref, "label": label, "text": text].compactMapValues { $0 } } }
    func typeFields(_ type: String) async -> [Field] {
        Self.isSample ? [] : (try? await call("return await orbital.typeFields(type)", ["type": type])) ?? []
    }
    func fieldChoices(_ key: String, _ query: String) async -> [Member] {
        Self.isSample ? [] : (try? await call("return await orbital.fieldChoices(key, query)", ["key": key, "query": query])) ?? []
    }
    func searchPreset(_ id: String) async -> Preset? {
        Self.isSample ? nil : (try? await call("return await orbital.searchPreset(id)", ["id": id])) ?? nil
    }
    func taskTypes() async -> [TaskType] {
        Self.isSample ? [] : (try? await call("return await orbital.taskTypes()", [:])) ?? []
    }
    // today: Quick Add's Pin to today, the made task pinned as a long press pins one; a task made but not pinned is not
    // made again, it says so
    func createTask(_ title: String, type: String?, search: String? = nil, assignee: String? = nil, values: [String: Value] = [:], today: Bool = false) async throws -> String {
        guard !Self.isSample else { throw Failure(errorDescription: "The sample saves nothing") }
        let id: String = try await call("return await orbital.createTask(title, type, search, assignee, values)", ["title": title, "type": type ?? NSNull(), "search": search ?? NSNull(),
                                                                                                        "assignee": assignee ?? NSNull(), "values": values.mapValues(\.json)])
        var notPinned: String? // said after the refresh below, which clears what was said before it
        if today {
            do { let _: Bool = try await call("return await orbital.pin(id, on)", ["id": id, "on": true]) }
            catch { notPinned = "“\(title)” was added, but not pinned to today: " + error.localizedDescription }
        }
        // a new task is yours alone: given to someone else, they are asked about as Assign to asks
        if assignee != nil, let access = await access(id), !access.hidden.isEmpty { asking = .init(id: id, access: access, shut: access.hidden, then: {}) }
        await refresh()
        if let notPinned { self.error = notPinned }
        return id
    }
    // The image made smaller (2048 px at most, JPEG) for the model and for Tana, read by ChatGPT, then made into its node
    func processImage(_ image: UIImage) async throws -> String {
        guard !Self.isSample else { throw Failure(errorDescription: "The sample saves nothing") }
        guard let jpeg = image.fitted(2048).jpegData(compressionQuality: 0.9) else { throw Failure(errorDescription: "The image could not be read") }
        let read = try await ChatGPT.readImage(jpeg, to: translator.to, model: translator.ai["model"]!, effort: translator.ai["effort"]!)
        let id: String = try await call("return await orbital.fromImage(kind, title, notes, image, 'image/jpeg')",
                                        ["kind": read.kind ?? "doc", "title": read.title ?? "", "notes": read.notes ?? [], "image": jpeg.base64EncodedString()])
        await refresh()
        return id
    }

    // Quick Add closes the moment you press Add: what it asked for is made here while you go on, and the + in the bar turns
    // while anything is on its way (Shell), so another can be added meanwhile. A task Tana did not take is kept as unsent,
    // and the next Quick Add opens with it and says why; an image's node opens once it is made, as the desktop opens it.
    var adding = 0
    var unsent: [Draft] = []
    var made: String?
    struct Draft { let title: String; let type: String?; let search: String?; let assignee: Member?; let values: [String: Value]; var today = false; var why: String? }
    func add(_ draft: Draft) {
        adding += 1
        Task {
            defer { adding -= 1 }
            do { _ = try await awake("Quick Add") { try await createTask(draft.title, type: draft.type, search: draft.search, assignee: draft.assignee?.id, values: draft.values, today: draft.today) } } catch {
                var kept = draft
                kept.why = error.localizedDescription
                unsent.append(kept)
                self.error = "“\(draft.title)” was not added: " + error.localizedDescription
            }
        }
    }
    // load: the image, read once Quick Add has gone (a Photos pick, the clipboard, something shared)
    func addImage(_ load: @escaping () async throws -> UIImage?) {
        adding += 1
        Task {
            defer { adding -= 1 }
            do { try await awake("Process image") {
                guard let image = try await load() else { throw Failure(errorDescription: "The image could not be read") }
                // shared while Orbital was not running: Tana connects first; signed out or failed, it says so rather than waiting for ever
                while phase != .ready {
                    guard phase == .starting else { throw Failure(errorDescription: "Sign in to Tana first, then share it again") }
                    try await Task.sleep(for: .milliseconds(200))
                }
                made = try await processImage(image)
            } } catch { self.error = error.localizedDescription }
        }
    }
    // Left right after Add, the app asks iOS to keep it running until Tana has the task (orbital.createTask answers only
    // then), rather than being suspended with it still on its way and losing it; iOS gives that half a minute or so
    private func awake<T>(_ name: String, _ work: () async throws -> T) async rethrows -> T {
        let running = Background(name)
        defer { running.end() }
        return try await work()
    }

    // Back in front (ContentView): a sync stream that died while iOS held the page suspended is made again first
    // (orbital.resume), so the read that follows is not answered short, Today's Tasks empty, by a dead one
    func foreground() async {
        if phase == .ready, !Self.isSample { _ = try? await web.callAsyncJavaScript("return await orbital.resume()", contentWorld: .page) }
        await refresh()
    }

    // iOS ended the page's process while the app was away (memory, or a crash): started again on a new one, the rows kept
    // on screen until the new read lands; what was asked of the old one has failed already (an add is kept as unsent)
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        note("iOS stopped Tana's page: starting it again")
        start()
    }

    // Long press, Delete (orbital.remove): to Tana's trash, then the Timeline read again; why not, when Tana says no
    // The row goes at once, collapsing out of its list (the List's own removal, under Reduce Motion without the move),
    // and comes back if Tana says no.
    func remove(_ id: String) async -> Bool {
        withAnimation(Self.collapse) { _ = removed.insert(id) }
        guard !Self.isSample else { return true }
        do {
            let _: String = try await call("return await orbital.remove(id)", ["id": id])
            await refresh()
            return true
        } catch {
            withAnimation(Self.collapse) { _ = removed.remove(id) }
            self.error = error.localizedDescription
            return false
        }
    }
    // a list without what was deleted here: a node, an entry about one, a search result for one, and an entry that is only
    // the tasks it brought ("added a task to your Inbox": no node of its own) once they are all deleted, so it goes with the
    // last of them in the one animation
    func shown(_ rows: [Row]?) -> [Row] {
        (rows ?? []).filter { row in
            let gone = { (id: String?) in id.map(self.removed.contains) ?? false }
            if gone(row.id) || gone(row.timeline?.uri) || gone(row.target) { return false }
            guard let tasks = row.children, !tasks.isEmpty, row.timeline != nil, row.timeline?.uri == nil else { return true }
            return !tasks.allSatisfy { gone($0.id) }
        }
    }

    // A message written into a chat: which chat, and a warning when Tana did not take it up (it is sent all the same)
    struct Sent: Decodable { let id: String; let warning: String? }
    // Ask Tana (orbital.ask): a new chat with what you typed as its first message
    func ask(_ text: String) async throws -> Sent {
        if Self.isSample { return Sent(id: "tana:chat:000000000000000000000000c1", warning: nil) }
        return try await call("return await orbital.ask(text)", ["text": text])
    }
    // a follow-up in a chat (orbital.send)
    func send(_ text: String, to id: String) async throws -> Sent {
        if Self.isSample { return Sent(id: id, warning: nil) }
        return try await call("return await orbital.send(id, text)", ["id": id, "text": text])
    }

    struct Failure: LocalizedError { let errorDescription: String? }
    private func call<T: Decodable>(_ js: String, _ arguments: [String: Any]) async throws -> T {
        try await call(js, arguments) { try JSONDecoder().decode(T.self, from: Data($0.utf8)) }
    }
    // decode: what to make of the JSON engine.js answers
    private func call<T>(_ js: String, _ arguments: [String: Any], decode: (String) throws -> T) async throws -> T {
        do {
            let owner = account ?? savedFor // whose screen this was asked from
            try await connected()
            // a tap on a row of another account's, made before Tana said who signed in: not done to this one
            if let owner, owner != account { throw Failure(errorDescription: "Another Tana account is signed in now, so this was not done") }
            // every call says first whether Demo mode is on (ios/engine/demo.js), so the engine refuses a write from the
            // moment it is turned on, not from the next Timeline read, which a read already under way puts off
            let json = try await web.callAsyncJavaScript("orbital.demo(demo); " + js, arguments: arguments.merging(["demo": demo]) { _, now in now },
                                                         contentWorld: .page) as? String ?? "null"
            return try decode(json)
        } catch {
            note("\(js.firstMatch(of: /orbital\.(\w+)/)?.1 ?? "engine") failed: \(Self.message(error))")
            throw Failure(errorDescription: Self.message(error))
        }
    }

    // The saved Timeline is on screen before the engine has connected: what is asked of it meanwhile waits for it
    private func connected() async throws {
        while phase == .starting { try await Task.sleep(for: .milliseconds(100)) }
        if case .failed(let message) = phase { throw Failure(errorDescription: message) }
        if phase == .signedOut { throw Failure(errorDescription: "Signed out of Tana") }
    }

    // -sample: pages-sample.json in place of Tana for these pages, invented content only
    private struct Sample: Decodable { let searches: [Row]; let pages: [String: Page] }
    private static let sample: Sample? = isSample
        ? Bundle.main.url(forResource: "pages-sample", withExtension: "json").flatMap { try? JSONDecoder().decode(Sample.self, from: Data(contentsOf: $0)) } : nil

    // A task's box: drawn in its new state at once, written by engine.js (orbital.toggle, the desktop's rule), and put
    // back with the reason in Details if Tana refuses. The row stays where it is (orbital-design: never move things
    // under the user); the next read confirms it.
    func toggle(_ task: Row) async {
        guard !demo else { return } // a box does nothing in demo mode, as the desktop's is disabled
        let before = state(of: task)
        states[task.id] = before == "proposed" || before == "closed" ? "open" : "closed"
        ticked[task.id] = .now
        defer { Task { await keepGlimpse() } } // the widgets show it ticked too
        guard !Self.isSample else { return } // the sample writes nothing
        do {
            states[task.id] = try await call("return await orbital.toggle(id)", ["id": task.id]) as String
        } catch {
            states[task.id] = before
            self.error = error.localizedDescription
        }
    }

    // Long press, Move to Inbox: the task back to Tana's Inbox state (proposed), drawn so at once and put back if Tana refuses
    func moveToInbox(_ id: String) async {
        guard !demo, !Self.isSample else { return }
        let before = states[id]
        states[id] = "proposed"
        do { states[id] = try await call("return await orbital.toggle(id, 'proposed')", ["id": id]) as String }
        catch { states[id] = before; self.error = error.localizedDescription }
    }

    // A widget's box (ios/Widgets): the task set to what the widget showed it becoming, drawn so at once and written as soon
    // as the engine has connected (a cold start waits for it), put back with the reason if Tana refuses. Set outright,
    // so a second tap on a widget not yet drawn again does not undo the first.
    func tick(_ id: String, to next: String) async {
        guard !demo else { return }
        let before = states[id]
        states[id] = next
        ticked[id] = .now
        defer { Task { await keepGlimpse() } } // the widgets drawn again with it
        guard !Self.isSample else { return }
        do { states[id] = try await call("return await orbital.toggle(id, to)", ["id": id, "to": next]) as String }
        catch { states[id] = before; self.error = error.localizedDescription }
    }

    func state(of task: Row) -> String {
        states[task.id] ?? task.stateType ?? (task.done == true ? "closed" : "open")
    }

    // The widgets' Timeline (ios/Widgets; Glimpse.kt on Android): the rows on screen, a box ticked here ticked and what was
    // deleted or unpinned here gone, each sensitive one without its words (nobody shakes a widget), left in the Keychain
    // where the widgets read it, as the Share extension leaves what it shares
    struct Glimpse: Encodable { let read: Int64; let rows: [Row] }

    func keepGlimpse() async {
        func kept(_ list: [Row]?, today: Bool = false) -> [Row]? {
            list.map { shown($0).filter { !today || !unpinned.contains($0.id) }.map { row in
                var r = row
                if r.sensitive == true {
                    r.text = nil; r.title = nil; r.segments = nil; r.subtext = nil; r.people = nil; r.reference?.label = nil
                    r.timeline?.note = nil; r.timeline?.change = nil; r.timeline?.detail = nil
                }
                // a tick made here: on the task, and on an Activity line about it (its uri), which the widget draws as the task
                r.stateType = states[r.id] ?? r.timeline?.uri.flatMap { states[$0] } ?? r.stateType
                r.children = kept(r.children, today: r.timeline?.today == true)
                return r
            } }
        }
        guard let data = try? JSONEncoder().encode(Glimpse(read: Int64(Date.now.timeIntervalSince1970 * 1000), rows: kept(rows) ?? [])) else { return }
        Keychain.save(data, "glimpse")
        WidgetCenter.shared.reloadAllTimelines()
        await keepTasks()
        await Tasks.index(demo: demo) // what Siri and Spotlight find (Intents.swift)
    }

    // Siri and Shortcuts' List Tasks and their task lookup (Intents.swift): the tasks assigned to you in every state
    // (orbital.tasks), kept in the Keychain beside the widgets' copy, a sensitive one without its words. Asked of Tana
    // after a read, at most once in five minutes; the sample keeps its own tasks.
    @ObservationIgnored private var tasksRead = Date.distantPast
    private func keepTasks() async {
        guard Date.now.timeIntervalSince(tasksRead) > 300 else { return }
        let list: [Row]
        if Self.isSample {
            var found: [Row] = []
            func walk(_ rows: [Row]) { for r in rows { if r.id.hasPrefix("tana:text:"), r.stateType != nil { found.append(r) }; walk(r.children ?? []) } }
            walk(rows)
            list = found
        } else {
            guard let read: [Row] = try? await call("return await orbital.tasks()", [:]) else { return }
            list = read
        }
        tasksRead = .now
        let kept = list.map { row in
            var r = row
            if r.sensitive == true { r.text = nil; r.title = nil; r.segments = nil }
            r.stateType = states[r.id] ?? r.stateType
            return r
        }
        if let data = try? JSONEncoder().encode(kept) { Keychain.save(data, "tasks") }
    }

    // A box ticked here goes back to reading Tana once a read shows it as ticked, or once a read still disagrees half a
    // minute on (Tana refused it later than toggle waits for, or someone changed it back): the graph can trail a write by
    // seconds, never by that long. One that is not in the rows read keeps its tick.
    private func settle(_ rows: [Row]) {
        states = states.filter { id, state in
            guard let read = Self.stateType(id, in: rows) else { return true }
            return read != state && Date.now.timeIntervalSince(ticked[id] ?? .distantPast) < 30
        }
        ticked = ticked.filter { states[$0.key] != nil }
    }

    private static func stateType(_ id: String, in rows: [Row]) -> String? {
        for row in rows {
            if row.id == id { return row.stateType }
            if let found = stateType(id, in: row.children ?? []) { return found }
        }
        return nil
    }

    // Launched with -sample: timeline-sample.json in place of Tana, for screenshots of the design. Invented content only;
    // its times are minutes from now ("{{min:-40}}", "{{ms:+44}}") so the page always reads as today's, and so are the
    // words the engine would put on them (ios/engine/labels.js; Times.kt sample): "{{hm:-40}}" the time, "{{day:-40}}"
    // the day, "{{date:-40}}" that day in words.
    private func showSample() {
        guard let url = Bundle.main.url(forResource: "timeline-sample", withExtension: "json"), var json = try? String(contentsOf: url, encoding: .utf8) else { return }
        let gb = Date.FormatStyle(locale: Locale(identifier: "en_GB")) // 24-hour, and the day as the desktop words it in English
        for match in json.matches(of: /"\{\{(min|ms|hm|day|date):([+-]?\d+)\}\}"/).reversed() {
            let at = Date.now.addingTimeInterval(Double(match.2)! * 60)
            let filled = switch match.1 {
            case "ms": String(Int(at.timeIntervalSince1970 * 1000))
            case "hm": "\"" + at.formatted(gb.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)) + "\""
            case "day": "\"" + TimelineScreen.key(at) + "\""
            case "date": "\"" + at.formatted(gb.weekday(.wide).day().month(.wide)) + "\""
            default: "\"" + at.ISO8601Format(.iso8601.year().month().day().time(includingFractionalSeconds: true)) + "\""
            }
            json.replaceSubrange(match.range, with: filled)
        }
        rows = (try? JSONDecoder().decode([Row].self, from: Data(json.utf8))) ?? []
        // -history: the day's entries only, so a shot of them needs no scrolling
        if CommandLine.arguments.contains("-history") { rows.removeAll { $0.timeline?.today == true || $0.timeline?.upcoming == true || $0.timeline?.free != nil } }
        phase = .ready
        Task { await keepGlimpse() }
    }

    // what engine.js threw, rather than WebKit's "A JavaScript exception occurred"
    private static func message(_ error: Error) -> String {
        (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription
    }
}

// The last Timeline read, kept on this phone and drawn at launch while Tana connects, as the desktop draws its cached rows
// before its sync client exists; the read that follows takes its place. In Caches, so never in a backup, and sealed while
// the phone is locked. Only your own account's and never in demo mode (Engine), and of a day gone by only what happened:
// Today's Tasks and Upcoming meetings come with the read, as does a free time that has ended.
@MainActor
enum SavedTimeline {
    private static let file = URL.cachesDirectory.appending(path: "timeline.json")
    private struct Head: Encodable { let account: String; let at: Double }
    private struct Saved: Decodable { let account: String; let at: Double; let rows: [Row] }

    // json: the rows as engine.js answered them, kept as they came
    static func save(_ json: String, account: String) {
        guard let head = try? JSONEncoder().encode(Head(account: account, at: Date.now.timeIntervalSince1970)) else { return }
        var data = Data(head.dropLast()) // its closing brace, which the rows close instead
        data.append(Data((",\"rows\":" + json + "}").utf8))
        try? data.write(to: file, options: [.atomic, .completeFileProtection])
    }

    static func load() -> (account: String, rows: [Row])? {
        guard let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(Saved.self, from: data) else { return nil }
        let today = Calendar.current.isDateInToday(Date(timeIntervalSince1970: saved.at)), now = Date.now.timeIntervalSince1970 * 1000
        return (saved.account, saved.rows.filter { row in today ? (row.timeline?.free?.until ?? .infinity) > now : !row.top })
    }

    static func forget() { try? FileManager.default.removeItem(at: file) }
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

extension UIImage {
    // At most side pixels on its longest side, drawn in pixels: a renderer's default is the screen's scale (3x on an
    // iPhone), which blew a shrunk screenshot back up three times over, blurred, before the model read it
    func fitted(_ side: CGFloat) -> UIImage {
        let pixels = CGSize(width: size.width * scale, height: size.height * scale), k = min(1, side / max(pixels.width, pixels.height))
        let target = CGSize(width: (pixels.width * k).rounded(), height: (pixels.height * k).rounded()), format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in draw(in: CGRect(origin: .zero, size: target)) }
    }
}

// A UIKit background task (Engine.awake): begun, and ended when the work is done, or by iOS's own deadline
@MainActor private final class Background {
    private var id = UIBackgroundTaskIdentifier.invalid
    init(_ name: String) { id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in MainActor.assumeIsolated { self?.end() } } }
    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}
