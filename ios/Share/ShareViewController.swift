import UIKit
import UniformTypeIdentifiers

// Share to Orbital: what was shared is left in the Keychain, where the app finds it (QuickAdd.swift Shared), and Orbital
// opened on Quick Add: an image to be read at once, anything else as words to edit there. No screen of its own.
final class ShareViewController: UIViewController {
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { await share() }
    }

    private func share() async {
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        Self.clear()
        var left = false
        if let image = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }),
           let data = await Self.data(image), let jpeg = Self.small(data) {
            left = Self.leave(jpeg, "shared.image")
        } else {
            // the words that came with it, then a link, then text, each once
            var words = items.compactMap { $0.attributedContentText?.string }
            for p in providers {
                if p.hasItemConformingToTypeIdentifier(UTType.url.identifier), let url = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL { words.append(url.absoluteString) }
                else if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), let text = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String { words.append(text) }
            }
            var seen = Set<String>()
            let text = words.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: "\n")
            left = Self.leave(Data(text.utf8), "shared.text")
        }
        // kept nothing (the Keychain said no): the share sheet says it failed, rather than Orbital opening on an empty Quick Add
        guard left else { return extensionContext?.cancelRequest(withError: CocoaError(.fileWriteUnknown)) ?? () }
        open(URL(string: "orbital-share://add")!)
        extensionContext?.completeRequest(returningItems: nil)
    }

    // The handoff: a Keychain item in Orbital's own access group (its application identifier, which this team's profiles
    // allow every target: Share.entitlements), read and removed by the app. A named pasteboard is not shared between an
    // extension and its app (it was read empty), and an App Group would need a capability registered for the team.
    private static let group = "6DA7MK99T2.com.dreetje.orbital"
    private static func item(_ account: String) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: "com.dreetje.orbital", kSecAttrAccount: account, kSecAttrAccessGroup: group]
    }
    private static func clear() { for account in ["shared.image", "shared.text"] { SecItemDelete(item(account) as CFDictionary) } }
    @discardableResult private static func leave(_ data: Data, _ account: String) -> Bool {
        var add = item(account)
        add[kSecValueData] = data
        add[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
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
