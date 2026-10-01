import CryptoKit
import SwiftUI
import WebKit

// Settings, opened from the side menu, laid out as the ChatGPT app's: no title, a close button top right, rounded groups
// under grey headings, each row a line glyph, its words and its value in grey
struct SettingsView: View {
    let engine: Engine
    @Environment(\.dismiss) private var dismiss
    @State private var chatgpt = ChatGPT.load()
    @State private var signingIn = false
    @State private var models: [ChatGPT.Model] = [] // the choices for Model, read when signed in

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent { Text(engine.email ?? "Tana") } label: { Row(glyph: "tana", title: "Account") }
                } header: { Header("Tana") }
                Section {
                    if let chatgpt {
                        LabeledContent { Text(chatgpt.email ?? "ChatGPT") } label: { Row(glyph: "chatgpt", title: "Account") }
                        if let plan = chatgpt.plan { LabeledContent { Text(plan.capitalized) } label: { Row(glyph: "license", title: "Plan") } }
                        // the Mac Settings page's Model and Thinking: one synced choice, the same remote list of models
                        if !models.isEmpty {
                            let model = engine.translator.model, efforts = models.first { $0.id == model }?.efforts ?? ["low", "medium", "high"]
                            Picker(selection: Binding { model } set: { id in Task {
                                await engine.aiChoice("model", id)
                                let next = models.first { $0.id == id }?.efforts ?? []
                                if !next.isEmpty, !next.contains(engine.translator.effort) { await engine.aiChoice("effort", next.contains("low") ? "low" : next[0]) }
                            } }) {
                                ForEach(models) { Text(ChatGPT.label($0.id)).tag($0.id) }
                                if !models.contains(where: { $0.id == model }) { Text(ChatGPT.label(model)).tag(model) } // a choice the list no longer has
                            } label: { Row(glyph: "brain", title: "Model") }
                            .pickerStyle(.menu).tint(.secondary)
                            Picker(selection: Binding { engine.translator.effort } set: { x in Task { await engine.aiChoice("effort", x) } }) {
                                ForEach(efforts, id: \.self) { Text(ChatGPT.effortLabel($0)).tag($0) }
                            } label: { Row(glyph: "sparkle", title: "Thinking") }
                            .pickerStyle(.menu).tint(.secondary)
                        }
                    } else {
                        Button { signingIn = true } label: { Row(glyph: "chatgpt", title: "Sign in with ChatGPT") }
                    }
                } header: {
                    Header("ChatGPT")
                } footer: {
                    Text("Your ChatGPT account is for the AI in Orbital and for Codex on your hosts. It stays on this iPhone. Model and Thinking are for reading images; other AI stays on Terra 5.6.")
                }
                Section {
                    // the language notes are shown in, the same synced setting as Cmd+K Auto-translate … on the Mac
                    Picker(selection: Binding { engine.translator.to ?? "" } set: { lang in Task { await engine.translate(into: lang.isEmpty ? nil : lang) } }) {
                        Text("Off").tag("")
                        ForEach(Translator.languages, id: \.self) { Text($0).tag($0) }
                    } label: { Row(glyph: "language", title: "Auto-translate") }
                    .pickerStyle(.menu)
                    .tint(.secondary) // its value in grey, as the other rows have theirs
                    Toggle(isOn: Binding { engine.demo } set: { engine.demo = $0 }) { Row(glyph: "hidden", title: "Demo mode") }.tint(.green) // the switch in its own colour: in the rows' text colour it is white on white
                    LabeledContent { Text(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") } label: { Row(glyph: "info", title: "Version") }
                } header: { Header("Orbital") } footer: {
                    if engine.translator.to != nil, let problem = engine.translator.problem { Text("Auto-translate: " + problem) } // why the last translation did not come
                    Text("Demo mode shows made-up words and names in place of yours, for showing Orbital to someone. Nothing is saved to Tana while it is on.")
                }
                // signing out, apart from everything else and in red, as the ChatGPT app has its Log out
                Section {
                    Button { dismiss(); Task { await engine.signOut() } } label: { LogOut(title: "Log out of Tana") }
                    if chatgpt != nil { Button { ChatGPT.forget(); chatgpt = nil } label: { LogOut(title: "Log out of ChatGPT") } }
                }
            }
            .tint(.primary) // the rows in the text colour, not the accent blue, as the ChatGPT app has them
            .task(id: chatgpt?.accessToken) { models = chatgpt == nil ? [] : (try? await ChatGPT.models()) ?? [] }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close")
                }
            }
            .sheet(isPresented: $signingIn) {
                ChatGPTSignIn { account in
                    chatgpt = account
                    signingIn = false
                }
            }
        }
    }

    // a row's glyph and words in the text colour: each account by its service's mark (Tana's, OpenAI's)
    struct Row: View {
        let glyph: String
        let title: String
        var body: some View {
            Label { Text(title) } icon: { Image("Glyphs/" + glyph).resizable().frame(width: 22, height: 22) }
                .foregroundStyle(.primary)
        }
    }

    struct LogOut: View {
        let title: String
        var body: some View {
            Label { Text(title) } icon: { Image(systemName: "rectangle.portrait.and.arrow.right") }.foregroundStyle(.red)
        }
    }

    // the ChatGPT app's group headings: its own words at a readable size, grey, not upper case
    struct Header: View {
        let title: String
        init(_ title: String) { self.title = title }
        // systemGray itself: a Form greys its headers already, so .secondary on top came out two steps lighter
        var body: some View { Text(title).font(.headline).foregroundStyle(Color(.systemGray)).textCase(nil) }
    }
}

// Sign in with ChatGPT as Codex does it (openai/codex codex-rs/login: OAuth with PKCE against auth.openai.com, Codex's
// client id and scopes, the answer sent to http://localhost:1455/auth/callback). The phone has no port to listen on, so
// the web view catches that address before it loads. The tokens stay in this phone's Keychain (#664, #665).
// ponytail: Codex's client id, fine for a personal build; Orbital's own id once registered with OpenAI (#664).
enum ChatGPT {
    static let issuer = "https://auth.openai.com"
    static let client = "app_EMoamEEZ73f0CkXaXp7hrann"
    static let redirect = "http://localhost:1455/auth/callback"
    static let scope = "openid profile email offline_access api.connectors.read api.connectors.invoke"

    struct Account: Codable {
        let idToken: String
        let accessToken: String
        let refreshToken: String
        enum CodingKeys: String, CodingKey { case idToken = "id_token", accessToken = "access_token", refreshToken = "refresh_token" }

        private var claims: [String: Any] { Self.claims(idToken) }
        var expires: Date { (Self.claims(accessToken)["exp"] as? Double).map { Date(timeIntervalSince1970: $0) } ?? .distantPast }
        var accountId: String? { (claims["https://api.openai.com/auth"] as? [String: Any])?["chatgpt_account_id"] as? String }
        static func claims(_ jwt: String) -> [String: Any] {
            let part = jwt.split(separator: ".").dropFirst().first.map(String.init) ?? ""
            var b64 = part.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            b64 += String(repeating: "=", count: (4 - b64.count % 4) % 4)
            return Data(base64Encoded: b64).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        }
        var email: String? { claims["email"] as? String }
        var plan: String? { (claims["https://api.openai.com/auth"] as? [String: Any])?["chatgpt_plan_type"] as? String }
    }

    static func load() -> Account? { Keychain.load("chatgpt").flatMap { try? JSONDecoder().decode(Account.self, from: $0) } }
    static func save(_ account: Account) { if let data = try? JSONEncoder().encode(account) { Keychain.save(data, "chatgpt") } }
    static func forget() { Keychain.delete("chatgpt") }

    // The account with a live access token: renewed with its refresh token a minute before it runs out, as Codex does
    // (codex-rs/login, the refresh_token grant); nil when signed out. A refresh refused leaves the account as it was.
    static func fresh() async throws -> Account? {
        guard let account = load() else { return nil }
        if account.expires > .now.addingTimeInterval(60) { return account }
        // no scope: the refresh keeps everything the sign-in was granted
        let request = tokenRequest(["grant_type": "refresh_token", "client_id": client, "refresh_token": account.refreshToken])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.userAuthenticationRequired) }
        struct Renewed: Decodable { let id_token: String?; let access_token: String?; let refresh_token: String? }
        let r = try JSONDecoder().decode(Renewed.self, from: data)
        let next = Account(idToken: r.id_token ?? account.idToken, accessToken: r.access_token ?? account.accessToken, refreshToken: r.refresh_token ?? account.refreshToken)
        save(next)
        return next
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func random() -> String { base64url(Data((0..<32).map { _ in UInt8.random(in: 0...255) })) }

    static func authorize(verifier: String, state: String) -> URL {
        var url = URLComponents(string: issuer + "/oauth/authorize")!
        url.queryItems = [
            .init(name: "response_type", value: "code"), .init(name: "client_id", value: client), .init(name: "redirect_uri", value: redirect),
            .init(name: "scope", value: scope), .init(name: "code_challenge", value: base64url(Data(SHA256.hash(data: Data(verifier.utf8))))),
            .init(name: "code_challenge_method", value: "S256"), .init(name: "id_token_add_organizations", value: "true"),
            .init(name: "codex_cli_simplified_flow", value: "true"), .init(name: "state", value: state), .init(name: "originator", value: "codex_cli_rs"),
        ]
        return url.url!
    }

    // A form posted to the token endpoint, as codex-rs/login posts both of its grants. A + is encoded too: URLComponents
    // leaves it, and a form body reads it as a space.
    static func tokenRequest(_ fields: [String: String]) -> URLRequest {
        var request = URLRequest(url: URL(string: issuer + "/oauth/token")!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var form = URLComponents()
        form.queryItems = fields.map { URLQueryItem(name: $0.key, value: $0.value) }
        request.httpBody = Data((form.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B").utf8)
        return request
    }

    // the code for tokens, as codex-rs/login exchange_code_for_tokens posts it
    static func exchange(code: String, verifier: String) async throws -> Account {
        let request = tokenRequest(["grant_type": "authorization_code", "code": code, "redirect_uri": redirect, "client_id": client, "code_verifier": verifier])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.userAuthenticationRequired) }
        return try JSONDecoder().decode(Account.self, from: data)
    }
}

// OpenAI's sign-in page, in a sheet: done with the account once the callback came back and its code was exchanged
struct ChatGPTSignIn: View {
    let done: (ChatGPT.Account) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            ChatGPTPage(done: done, failed: { failure = $0 })
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle("Sign in with ChatGPT")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
                .safeAreaInset(edge: .bottom) {
                    if let failure { Text(failure).font(.footnote).foregroundStyle(.secondary).padding(8).frame(maxWidth: .infinity).background(.bar) }
                }
        }
    }
}

struct ChatGPTPage: UIViewRepresentable {
    let done: (ChatGPT.Account) -> Void
    let failed: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(done: done, failed: failed) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent() // OpenAI's own cookies are not needed once the tokens are here
        let web = WKWebView(frame: .zero, configuration: config)
        web.customUserAgent = Engine.safari
        web.navigationDelegate = context.coordinator
        web.load(URLRequest(url: ChatGPT.authorize(verifier: context.coordinator.verifier, state: context.coordinator.state)))
        return web
    }
    func updateUIView(_ view: WKWebView, context: Context) {}

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate {
        let verifier = ChatGPT.random(), state = ChatGPT.random()
        let done: (ChatGPT.Account) -> Void, failed: (String) -> Void
        init(done: @escaping (ChatGPT.Account) -> Void, failed: @escaping (String) -> Void) { self.done = done; self.failed = failed }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url, url.absoluteString.hasPrefix(ChatGPT.redirect) else { return Engine.allowHere }
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let value = { (name: String) in items.first { $0.name == name }?.value }
            guard value("state") == state, let code = value("code") else {
                failed(value("error_description") ?? value("error") ?? "The sign-in did not come back from ChatGPT. Try again.")
                return .cancel
            }
            do {
                let account = try await ChatGPT.exchange(code: code, verifier: verifier)
                ChatGPT.save(account)
                done(account)
            } catch {
                failed("ChatGPT did not accept the sign-in. Try again.")
            }
            return .cancel
        }
    }
}
