import SwiftUI

// Your personal agent on the iPhone (your OpenAI Dot, or any agent that speaks MCP), as the Mac's Cmd+K has it
// (renderer/agent.js, main/agents/linked.js, ios/engine/agents.js): Settings' Agents, Connect your personal agent with a
// one-time code, and Assign to <its name> … from a long press, with the
// request written here and the node's own words left in Tana. What is linked and handed over is in your settings
// document, so the Mac sees it too.

// Settings' Agents: each agent linked through orbital.md, by the name it gave itself, swiped right to make it the default
// and left to unlink it, then Connect your personal agent
struct AgentsSection: View {
    let engine: Engine
    @State private var problem: String?

    var body: some View {
        Section {
            ForEach(engine.agents) { a in
                LabeledContent { Text([a.isDefault ? "Default" : nil, a.on ? nil : "Off"].compactMap { $0 }.joined(separator: " · ")) } label: {
                    SettingsView.Row(glyph: "robot", title: a.name)
                }
                // their own colours: the Form's tint (the rows' text colour) would draw them white on white
                .swipeActions(edge: .trailing) {
                    Button("Unlink", role: .destructive) { Task { await engine.unlink(a) } }.tint(.red)
                }
                .swipeActions(edge: .leading) {
                    if !a.isDefault { Button("Make Default") { Task { await engine.makeDefault(a) } }.tint(.blue) }
                }
            }
            NavigationLink { ConnectAgent(engine: engine) } label: { SettingsView.Row(glyph: "mcp", title: "Connect your personal agent") }
        } header: { SettingsView.Header("Agents") } footer: {
            if let problem { Text(problem) }
            if engine.agents.isEmpty { Text("Link your personal agent, like your OpenAI Dot, and hand it a task or a note with a long press. It reads the node in Tana itself.") }
        }
        .task { problem = await engine.loadAgents() }
    }
}

// Connect your personal agent: both plugins (MCP servers) added to your agent, then the instructions with a one-time code
// sent to it. The ? beside the plugins opens ConnectHelp: your OpenAI Dot step by step, then any other agent. The page
// asks every two seconds whether the code was used and goes back once it was. Leaving it does not stop the code: an agent
// that uses it later shows up all the same, as on the Mac.
struct ConnectAgent: View {
    let engine: Engine
    @Environment(\.dismiss) private var dismiss
    @State private var link: Engine.LinkCode?
    @State private var state = "asking" // asking, waiting, expired, failed, linked
    @State private var failure: String?
    @State private var linked: String? // "Echo · ChatGPT", once it is
    @State private var copied: String? // what was copied last, said on its row for a moment
    @State private var help = false

    var body: some View {
        Form {
            Section {
                if let link {
                    copy("Orbital", link.url, glyph: "robot")
                    copy("Tana", link.tana, glyph: "tana")
                }
            } header: {
                HStack {
                    SettingsView.Header("Add both plugins")
                    Spacer()
                    Button { help = true } label: { Image(systemName: "questionmark.circle").font(.headline) }
                        .accessibilityLabel("Help")
                }
            } footer: {
                Text("Add each to your agent as a custom MCP server, a name and a URL. A tap copies the URL.")
            }
            Section {
                switch state {
                case "asking": HStack { ProgressView(); Text("Getting a code…").foregroundStyle(.secondary) }
                case "failed":
                    Text(failure ?? "No code").foregroundStyle(.secondary)
                    Button("Try again") { Task { await ask() } }
                case "linked": Label("Linked " + (linked ?? "your agent"), systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                default:
                    if let link {
                        Button { UIPasteboard.general.string = link.prompt; said("message") } label: {
                            LabeledContent { Text(copied == "message" ? "Copied" : "") } label: { Label("Copy the instructions", systemImage: "doc.on.doc") }
                        }
                        if state == "expired" || link.expiresAt <= Date.now.timeIntervalSince1970 * 1000 {
                            Text("The code expired. Nobody used it.").foregroundStyle(.secondary)
                            Button("Get a new code") { Task { await ask() } }
                        } else {
                            TimelineView(.periodic(from: .now, by: 1)) { _ in
                                // a glyph's column, as the rows above, so the words line up
                                HStack {
                                    Label { Text("Waiting for your agent to use the code…").foregroundStyle(.secondary) } icon: { ProgressView() }
                                    Spacer()
                                    Text(Self.left(link.expiresAt)).monospacedDigit().foregroundStyle(.secondary)
                                }
                            }
                            Button(role: .destructive) { Task { await engine.linkCancel(link.code); dismiss() } } label: {
                                Label("Cancel", systemImage: "xmark.circle").foregroundStyle(.red)
                            }
                        }
                    }
                }
            } header: { SettingsView.Header("Then ask your agent to link") } footer: {
                Text("Send the instructions to your agent. The code works once, for fifteen minutes.\n\nOnly the node's id and your request go through orbital.md, and it keeps neither: the node's words stay in Tana, where your agent reads them with its own Tana access.")
            }
        }
        .tint(.primary)
        .navigationTitle("Connect your personal agent")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(isPresented: $help) { ConnectHelp(link: link) }
        .task { await ask() }
        .task(id: link?.code) { await poll() }
    }

    // a server as ChatGPT's form asks for it, a name and a URL: a tap copies the URL
    private func copy(_ name: String, _ url: String, glyph: String) -> some View {
        Button { UIPasteboard.general.string = url; said(name) } label: {
            LabeledContent { Text(copied == name ? "Copied" : url.replacingOccurrences(of: "https://", with: "")).lineLimit(1) } label: { SettingsView.Row(glyph: glyph, title: name) }
        }
    }
    private func said(_ what: String) {
        copied = what
        Task { try? await Task.sleep(for: .seconds(2)); if copied == what { copied = nil } }
    }
    private func ask() async {
        state = "asking"; failure = nil
        do { link = try await engine.linkCode(); state = "waiting" } catch { failure = error.localizedDescription; state = "failed" }
    }
    private func poll() async {
        guard let code = link?.code else { return }
        while state == "waiting", !Task.isCancelled {
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, let s = try? await engine.linkStatus(code) else { continue } // a missed answer: the next one asks again
            if s.state == "linked", let a = s.agent {
                linked = a.name
                state = "linked"
                _ = await engine.loadAgents()
                try? await Task.sleep(for: .seconds(1.2))
                dismiss()
            } else if s.state != "waiting" { state = s.state }
        }
    }
    static func left(_ expiresAt: Double) -> String {
        let s = max(0, Int(expiresAt / 1000 - Date.now.timeIntervalSince1970))
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }
}

// The ? beside Add both plugins: your OpenAI Dot step by step, with ChatGPT's plugins a tap away, then the same for any
// other agent that can add MCP servers and hear MCP events
struct ConnectHelp: View {
    let link: Engine.LinkCode?
    static let plugins = URL(string: "https://chatgpt.com/plugins")!
    private var orbital: String { (link?.url ?? "https://orbital.md/mcp").replacingOccurrences(of: "https://", with: "") }
    private var tana: String { (link?.tana ?? "https://home.tana.inc/mcp").replacingOccurrences(of: "https://", with: "") }

    var body: some View {
        Form {
            Section {
                Link(destination: Self.plugins) { SettingsView.Row(glyph: "chatgpt", title: "Open ChatGPT plugins") }
                step(1, "Open ChatGPT plugins, tap **Add**, then **Create custom MCP server**.")
                step(2, "Name it **Orbital**, with the URL \(orbital). Leave the rest as it is: ChatGPT signs in to Orbital by itself.")
                step(3, "Add a second one named **Tana**, with the URL \(tana), and sign in with your Tana account when it asks.")
                step(4, "Come back, tap **Copy the instructions** and send them to your Dot in ChatGPT.")
            } header: { SettingsView.Header("Your OpenAI Dot") } footer: {
                Text("Your Dot links itself with the code, and the page says Linked. The code works once, for fifteen minutes.")
            }
            Section {
                step(1, "Add **Orbital** to your agent as an MCP server, with the URL \(orbital).")
                step(2, "Add **Tana** as an MCP server too, with the URL \(tana), signed in with your Tana account.")
                step(3, "Tap **Copy the instructions** and send them to your agent.")
            } header: { SettingsView.Header("Any other agent") } footer: {
                Text("Your agent needs support for MCP events: that is how it hears about the tasks you hand it.")
            }
        }
        .tint(.primary)
        .navigationTitle("Adding the plugins")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func step(_ n: Int, _ words: String) -> some View {
        Label { Text(LocalizedStringKey(words)) } icon: { Image(systemName: "\(n).circle") }
    }
}

// Your agent picked in Assign to …, or asked again from a node's Agent field: what it should do with the node, written or
// dictated here (as Quick Add's title is) and sent with the handoff; the node itself is only read, as content. Assign
// closes it at once and the handoff goes on behind it, the + turning meanwhile (Engine.handOff); a request the agent did
// not take is said and kept, and opens here again. done closes whatever it was opened in.
struct HandForm: View {
    let engine: Engine
    let handing: Engine.Handing
    let done: () -> Void
    @State private var request = ""
    @State private var settling = false // Assign pressed while dictating: the words are waited for (Dictate shows it)
    @State private var dictation = Dictation()
    @FocusState private var focused: Bool

    var body: some View {
        Form {
            Section {
                // the request, and dictating it: the microphone starts listening; while it listens, ✕ throws the recording
                // away and ■ stops it, its words then added to the request
                HStack(alignment: .top, spacing: 10) {
                    if !dictation.recording { TextField("What should \(handing.agent.name) do?", text: $request, axis: .vertical).lineLimit(4...12).focused($focused) }
                    Dictate(dictation: dictation, into: append)
                }
            } footer: {
                Text([dictation.problem, "\(handing.agent.name) reads the node in Tana. Only what you write here tells it what to do."].compactMap { $0 }.joined(separator: "\n\n"))
            }
        }
        .navigationTitle("Assign to " + handing.agent.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Assign") { Task { await send() } }
                    .disabled((request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !dictation.recording && !dictation.transcribing) || settling)
            }
        }
        .onAppear {
            if request.isEmpty, let kept = engine.unhanded[handing.id] { request = kept } // not taken last time: written again
            focused = true
        }
        .onDisappear { dictation.cancel() } // closed while listening: nothing kept
        .interactiveDismissDisabled(!request.isEmpty || dictation.recording || dictation.transcribing)
    }

    // dictated words land after what the request already says
    private func append(_ said: String) { request = request.isEmpty ? said : request + " " + said }

    // Assign while listening or still transcribing: listening stops and the words are waited for, then it goes; one whose
    // words did not come is not sent, so nothing said is lost without a word
    private func send() async {
        guard !settling else { return }
        if dictation.recording || dictation.transcribing {
            settling = true
            defer { settling = false }
            guard await dictation.settle(into: append) else { return }
        }
        let words = request.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return }
        engine.handOff(handing, words)
        done()
    }
}

// The same, in a sheet of its own: Ask again from a node's Agent field
struct HandSheet: View {
    let engine: Engine
    let handing: Engine.Handing
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            HandForm(engine: engine, handing: handing) { dismiss() }
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

extension Engine.HandedTo {
    // its last Agent status line, as the Mac's badge reads it: Assigned is waiting for the agent to pick it up
    var word: String { ["assigned": "Assigned", "working": "Working", "completed": "Completed", "failed": "Failed"][status] ?? "Assigned" }
}

extension Engine {
    // what can be handed to an agent: a node of yours, not a chat, a search or a person
    static func handable(_ id: String) -> Bool { id.hasPrefix("tana:") && !["chat", "search", "user-profile"].contains(Glyph.kind(of: id) ?? "") }
}
