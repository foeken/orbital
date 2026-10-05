import Security
import SwiftUI

// What the app, its widgets and its Share extension have in common: this folder is compiled into each of the three
// targets (project.pbxproj, its Common group).

// The desktop's glyph for a node's kind (main/rows.js), a node's kind from its id, and the Timeline rail's marker for a
// row's icon (main/timeline.js ICON); the glyphs are each target's own catalog (scripts/build-ios-glyphs.js)
enum Glyph {
    static func of(_ kind: String?) -> String {
        switch kind {
        case "event": "calendar"
        case "space": "space"
        case "user-profile": "member"
        case "chat": "discuss"
        case "search": "search"
        default: "doc"
        }
    }
    // a node's kind from its id (tana:<kind>:<ulid>), and the glyph for it
    static func kind(of uri: String?) -> String? { uri?.split(separator: ":").dropFirst().first.map(String.init) }
    static func of(uri: String) -> String { of(kind(of: uri)) }
    // a meeting by its calendar (the desktop draws its type's glyph, calendar)
    static func marker(_ icon: String?) -> String {
        switch icon {
        case "tlAccepted", "tlLater", "tlInbox", "tlNew", "updated", "robot", "tana", "free", "todayTasks", "pinRoute": icon ?? "calendar"
        default: "calendar"
        }
    }
}

// The Timeline's days, as the engine keys them (ios/engine/labels.js: YYYY-MM-DD in this phone's time zone), and each
// day's heading: Today and Yesterday said here against this phone's date, so they are right past midnight before the
// next read; any other day in the engine's words for it (renderer/timeline.js timelineDay; Times.kt day)
enum Day {
    static func key(_ d: Date) -> String { d.formatted(Date.ISO8601FormatStyle(timeZone: .current).year().month().day()) }
    static func heading(_ key: String, _ title: String?, now: Date = .now) -> String {
        if key == Self.key(now) { return "Today" }
        if let before = Calendar.current.date(byAdding: .day, value: -1, to: now), key == Self.key(before) { return "Yesterday" }
        return title ?? key
    }
    // consecutive rows under one day, in the order they come (renderer/timeline.js timelineGroups)
    static func sections<R>(_ rows: [R], now: Date = .now, key: (R) -> String?, title: (R) -> String?) -> [(title: String, rows: [R])] {
        var out: [(key: String, title: String, rows: [R])] = []
        for row in rows {
            let k = key(row) ?? ""
            if out.last?.key == k { out[out.count - 1].rows.append(row) } else { out.append((k, heading(k, title(row), now: now), [row])) }
        }
        return out.map { ($0.title, $0.rows) }
    }
}

extension Date {
    // Tana's times, with or without fractional seconds ("2026-09-30T13:00:00Z", "…:00.000Z")
    static func tana(_ s: String) -> Date? {
        (try? Date(s, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true))) ?? (try? Date(s, strategy: .iso8601))
    }
}

extension Color {
    // Orbital's green for finished work (styles.css .tl-done), the same on every task box
    static let done = Color(red: 0x5a / 255, green: 0x96 / 255, blue: 0x70 / 255)
    // one of the desktop's light colours and its dark twin (styles.css and its [data-theme="dark"] rules)
    static func pair(_ light: UInt32, _ dark: UInt32) -> Color {
        let rgb = { (v: UInt32) in UIColor(red: CGFloat(v >> 16 & 0xff) / 255, green: CGFloat(v >> 8 & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1) }
        return Color(UIColor { $0.userInterfaceStyle == .dark ? rgb(dark) : rgb(light) })
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

// What Orbital keeps secret, on this phone only (never synced, never in a backup to another device). The app reads and
// writes its own items; the extensions name Orbital's own access group (group), its application identifier, which their
// entitlements list: the Share extension leaves what is shared there, the widgets read the app's copy of the Timeline.
// A named pasteboard is not shared between an extension and its app, and an App Group needs a capability registered.
enum Keychain {
    static let group = "6DA7MK99T2.com.dreetje.orbital"
    private static func item(_ account: String, _ group: String?) -> [CFString: Any] {
        var item: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: "com.dreetje.orbital", kSecAttrAccount: account]
        if let group { item[kSecAttrAccessGroup] = group }
        return item
    }

    @discardableResult static func save(_ data: Data, _ account: String, group: String? = nil) -> Bool {
        SecItemDelete(item(account, group) as CFDictionary)
        var add = item(account, group)
        add[kSecValueData] = data
        add[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func load(_ account: String, group: String? = nil) -> Data? {
        var query = item(account, group)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var out: CFTypeRef?
        return SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    static func delete(_ account: String, group: String? = nil) { SecItemDelete(item(account, group) as CFDictionary) }
}
