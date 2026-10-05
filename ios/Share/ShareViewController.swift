import UIKit
import UniformTypeIdentifiers

// Share to Orbital: what was shared is left in the Keychain, where the app finds it (QuickAdd.swift Shared), and Orbital
// opened on Quick Add: an image to read there once tapped, anything else as words to edit. No screen of its own.
final class ShareViewController: UIViewController {
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { await share() }
    }

    private func share() async {
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        for account in ["shared.image", "shared.text"] { Keychain.delete(account, group: Keychain.group) }
        var left = false
        if let image = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }),
           let data = await Self.data(image), let jpeg = Self.small(data) {
            left = Keychain.save(jpeg, "shared.image", group: Keychain.group)
        } else {
            // the words that came with it, then a link, then text, each once
            var words = items.compactMap { $0.attributedContentText?.string }
            for p in providers {
                if p.hasItemConformingToTypeIdentifier(UTType.url.identifier), let url = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL { words.append(url.absoluteString) }
                else if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), let text = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String { words.append(text) }
            }
            var seen = Set<String>()
            let text = words.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: "\n")
            left = Keychain.save(Data(text.utf8), "shared.text", group: Keychain.group)
        }
        // kept nothing (the Keychain said no): the share sheet says it failed, rather than Orbital opening on an empty Quick Add
        guard left else { return extensionContext?.cancelRequest(withError: CocoaError(.fileWriteUnknown)) ?? () }
        open(URL(string: "orbital-share://add")!)
        extensionContext?.completeRequest(returningItems: nil)
    }

    // 2048 px at most, as JPEG: what Quick Add reads it at anyway (Engine.processImage), and small enough for the Keychain
    private static func small(_ data: Data) -> Data? { UIImage(data: data).flatMap { $0.fitted(2048).jpegData(compressionQuality: 0.9) } }

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
            if let app = responder as? UIApplication, app.responds(to: NSSelectorFromString("openURL:options:completionHandler:")) {
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
