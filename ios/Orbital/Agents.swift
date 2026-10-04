import SwiftUI

// Your Dot on the iPhone, as the Mac's Cmd+K has it (renderer/agent.js, main/agents/linked.js, ios/engine/agents.js):
// Settings' Agents, Connect to your OpenAI Dot with a one-time code, and Assign to <its name> … from a long press, with the
// request written here and the node's own words left in Tana. What is linked and handed over is in your settings
// document, so the Mac sees it too.

// Settings' Agents: each agent linked through orbital.md, by the name it gave itself, swiped right to make it the default
// and left to unlink it, then Connect to your OpenAI Dot
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
            NavigationLink { ConnectDot(engine: engine) } label: { SettingsView.Row(glyph: "chatgpt", title: "Connect to your OpenAI Dot") }
        } header: { SettingsView.Header("Agents") } footer: {
            if let problem { Text(problem) }
            if engine.agents.isEmpty { Text("Link your Dot, OpenAI's agent in ChatGPT, and hand it a task or a note with a long press. It reads the node in Tana itself.") }
        }
        .task { problem = await engine.loadAgents() }
    }
}

// Connect to your OpenAI Dot: both servers added in ChatGPT, then the message with a one-time code sent to your Dot. The page
// asks every two seconds whether the code was used and goes back once it was. Leaving it does not stop the code: a Dot that
// uses it later shows up all the same, as on the Mac.
struct ConnectDot: View {
    let engine: Engine
    @Environment(\.dismiss) private var dismiss
    @State private var link: Engine.LinkCode?
    @State private var state = "asking" // asking, waiting, expired, failed, linked
    @State private var failure: String?
    @State private var linked: String? // "Echo · ChatGPT", once it is
    @State private var copied: String? // what was copied last, said on its row for a moment
    static let plugins = URL(string: "https://chatgpt.com/plugins")!

    var body: some View {
        Form {
            Section {
                Link(destination: Self.plugins) { SettingsView.Row(glyph: "chatgpt", title: "Open ChatGPT plugins") }
                if let link {
                    copy("Orbital", link.url, glyph: "robot")
                    copy("Tana", link.tana, glyph: "tana")
                }
            } header: { SettingsView.Header("Add both in ChatGPT") } footer: {
                Text("Add, then Create custom MCP server: a name and a URL each, the rest as it is.")
            }
            Section {
                switch state {
                case "asking": HStack { ProgressView(); Text("Getting a code…").foregroundStyle(.secondary) }
                case "failed":
                    Text(failure ?? "No code").foregroundStyle(.secondary)
                    Button("Try again") { Task { await ask() } }
                case "linked": Label("Linked " + (linked ?? "your Dot"), systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                default:
                    if let link {
                        Button { UIPasteboard.general.string = link.prompt; said("message") } label: {
                            LabeledContent { Text(copied == "message" ? "Copied" : "") } label: { Label("Copy the message for your Dot", systemImage: "doc.on.doc") }
                        }
                        if state == "expired" || link.expiresAt <= Date.now.timeIntervalSince1970 * 1000 {
                            Text("The code expired. Nobody used it.").foregroundStyle(.secondary)
                            Button("Get a new code") { Task { await ask() } }
                        } else {
                            TimelineView(.periodic(from: .now, by: 1)) { _ in
                                // a glyph's column, as the rows above, so the words line up
                                HStack {
                                    Label { Text("Waiting for your Dot to use the code…").foregroundStyle(.secondary) } icon: { ProgressView() }
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
            } header: { SettingsView.Header("Then ask your Dot to link") } footer: {
                Text("Send the message to your Dot in ChatGPT. The code works once, for fifteen minutes.\n\nOnly the node's id and your request go through orbital.md, and it keeps neither: the node's words stay in Tana, where your Dot reads them with its own Tana access.")
            }
        }
        .tint(.primary)
        .navigationTitle("Connect to your OpenAI Dot")
        .navigationBarTitleDisplayMode(.inline)
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

// Your Dot picked in Assign to …, or asked again from a node's Agent field: what it should do with the node, written here
// and sent with the handoff; the node itself is only read, as content. Assign stays until the agent took it, and says why
// not when it did not (not listening yet, read-only). done closes whatever it was opened in.
struct HandForm: View {
    let engine: Engine
    let handing: Engine.Handing
    let done: () -> Void
    @State private var request = ""
    @State private var sending = false
    @State private var failure: String?
    @FocusState private var focused: Bool

    var body: some View {
        Form {
            Section {
                TextField("What should \(handing.agent.name) do?", text: $request, axis: .vertical).lineLimit(4...12).focused($focused)
            } footer: {
                Text("\(handing.agent.name) reads the node in Tana. Only what you write here tells it what to do.")
            }
            if let failure { Section { Text(failure).foregroundStyle(.red) } }
        }
        .navigationTitle("Assign to " + handing.agent.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if sending { ProgressView() } else { Button("Assign") { Task { await send() } }.disabled(request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            }
        }
        .onAppear { focused = true }
        .interactiveDismissDisabled(sending || !request.isEmpty)
    }

    private func send() async {
        sending = true; failure = nil
        defer { sending = false }
        do {
            try await engine.hand(handing.id, to: handing.agent, request)
            done()
            await handing.then()
        } catch { failure = error.localizedDescription }
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
