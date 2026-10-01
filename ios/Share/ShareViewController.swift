import UIKit
import UniformTypeIdentifiers

// Share to Orbital: what was shared is left on Orbital's own pasteboard, where the app finds it (QuickAdd.swift Shared), and
// Orbital opened on Quick Add: an image to be read at once, anything else as words to edit there. No screen of its own.
final class ShareViewController: UIViewController {
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { await share() }
    }

    private func share() async {
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        // a named pasteboard only apps of the same team can read: no App Group, so no capability to provision
        let board = UIPasteboard(name: UIPasteboard.Name("com.dreetje.orbital.shared"), create: true)!
        if let image = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }),
           let data = await Self.data(image) {
            board.setItems([["com.dreetje.orbital.image": data]])
        } else {
            // the words that came with it, then a link, then text, each once
            var words = items.compactMap { $0.attributedContentText?.string }
            for p in providers {
                if p.hasItemConformingToTypeIdentifier(UTType.url.identifier), let url = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL { words.append(url.absoluteString) }
                else if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), let text = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String { words.append(text) }
            }
            var seen = Set<String>()
            let text = words.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: "\n")
            board.setItems([["com.dreetje.orbital.text": Data(text.utf8)]])
        }
        open(URL(string: "orbital-share://add")!)
        extensionContext?.completeRequest(returningItems: nil)
    }

    private static func data(_ provider: NSItemProvider) async -> Data? {
        await withCheckedContinuation { done in
            _ = provider.loadDataRepresentation(for: .image) { data, _ in done.resume(returning: data) }
        }
    }

    // A share extension may not open its app (UIApplication.open is not for extensions), so the app is asked through the
    // responder chain, as share extensions do; should iOS refuse, Orbital opens Quick Add the next time it comes forward
    private func open(_ url: URL) {
        var next: UIResponder? = self
        while let responder = next {
            if let app = responder as? UIApplication {
                // called through its own three-argument signature: perform(_:with:with:) passes two, and the completion
                // handler slot read garbage
                let selector = NSSelectorFromString("openURL:options:completionHandler:")
                typealias Open = @convention(c) (AnyObject, Selector, URL, [UIApplication.OpenExternalURLOptionsKey: Any], ((Bool) -> Void)?) -> Void
                unsafeBitCast(app.method(for: selector), to: Open.self)(app, selector, url, [:], nil)
                return
            }
            next = responder.next
        }
    }
}
