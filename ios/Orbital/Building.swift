import SwiftUI

// Loading, as the desktop's (renderer/loading.js): while the Timeline's first rows are on their way, the page builds
// itself where they will be, row by row, each a small outlined glyph (a task's box, a document, a meeting, a bullet)
// rising in and a rounded bar for its words growing in from the left, with a soft band of light running through the
// bars until the rows land. The same page on every launch; nothing drawn for the first 0.3 s, so a quick load never
// blinks it; one still, built frame under Reduce Motion. One colour at a few strengths, so it follows the theme.
struct Building: View {
    @Environment(\.accessibilityReduceMotion) private var still
    @State private var start = Date.now

    private struct Item { let x, y, w, h, a, start, dur: Double; var glyph: Int? = nil }
    private struct Line { var head: Bool; let glyph: Int; let w: Double; let meta: Double }
    // loading.js ROWS, from its seed: section headings now and then, never two together, some rows with a second line
    private static let lines: [Line] = {
        var seed = 20260926.0
        func rnd() -> Double { seed = (seed * 16807).truncatingRemainder(dividingBy: 2147483647); return seed / 2147483647 }
        var out = (0..<30).map { i in
            let head = i == 0 || (i > 2 && rnd() < 0.12), glyph = Int(rnd() * 4), w = 0.3 + 0.5 * rnd(), meta = rnd() < 0.5 ? 0.2 + 0.3 * rnd() : 0
            return Line(head: head, glyph: glyph, w: w, meta: meta)
        }
        for i in out.indices.dropFirst() where out[i - 1].head { out[i].head = false }
        return out
    }()

    // where each part goes on the Timeline's rail (Rail: time, marker, words), and when it comes in
    private static func items(width: Double, height: Double) -> [Item] {
        var out: [Item] = [], y = 16.0, s = 0.1
        let words = Rail.inset + Rail.time + Rail.gap + Rail.marker + Rail.gap, avail = max(120, width - words - 24)
        for l in lines where y < height {
            if l.head {
                y += y > 16 ? 18 : 0
                out.append(Item(x: 20, y: y + 12, w: 60 + l.w * 50, h: 9, a: 0.08, start: s, dur: 0.5))
                y += 44; s += 0.08; continue
            }
            out.append(Item(x: Rail.inset + Rail.time - 32, y: y + 4, w: 32, h: 8, a: 0.06, start: s, dur: 0.4))
            out.append(Item(x: Rail.inset + Rail.time + Rail.gap + 4, y: y, w: 16, h: 16, a: 0.26, start: s, dur: 0.4, glyph: l.glyph))
            out.append(Item(x: words, y: y + 3, w: max(40, avail * l.w), h: 11, a: 0.11, start: s + 0.08, dur: 0.8))
            if l.meta > 0 { out.append(Item(x: words, y: y + 25, w: avail * l.meta, h: 9, a: 0.065, start: s + 0.4, dur: 0.5)); y += 22 }
            y += 44; s += 0.09
        }
        return out
    }

    var body: some View {
        TimelineView(.animation(paused: still)) { frame in
            Canvas { ctx, size in
                let t = still ? 99 : frame.date.timeIntervalSince(start) - 0.3
                guard t >= 0 else { return }
                let base = Color.primary.opacity(0.55)
                for it in Self.items(width: size.width, height: size.height) {
                    let p = (t - it.start) / it.dur
                    guard p > 0 else { continue }
                    let eased = 1 - pow(1 - min(1, p), 3)
                    var c = ctx
                    c.opacity = it.a / 0.55 * min(1, p * 2.5)
                    if let g = it.glyph {
                        c.stroke(Self.glyph(g, x: it.x, y: it.y + 3 * (1 - eased)), with: .color(base), lineWidth: 1.5)
                        continue
                    }
                    let bar = Path(roundedRect: CGRect(x: it.x, y: it.y, width: max(it.h, it.w * eased), height: it.h), cornerRadius: it.h / 2)
                    if still { c.fill(bar, with: .color(base)); continue }
                    // the band of light, the rows lower down a step behind the ones above
                    let phase = ((t / 1.8 - it.y / 900).truncatingRemainder(dividingBy: 1) + 1).truncatingRemainder(dividingBy: 1)
                    let bx = it.x - 160 + phase * (it.w + 320)
                    c.fill(bar, with: .linearGradient(Gradient(colors: [base, .primary, base]), startPoint: CGPoint(x: bx - 120, y: 0), endPoint: CGPoint(x: bx + 120, y: 0)))
                }
            }
        }
        // it thins out down the page
        .mask(LinearGradient(stops: [.init(color: .black, location: 0.3), .init(color: .clear, location: 0.85)], startPoint: .top, endPoint: .bottom))
        .allowsHitTesting(false)
        .accessibilityElement()
        .accessibilityLabel("Loading")
    }

    // 16 pt, the size of a row's marker
    private static func glyph(_ g: Int, x: Double, y: Double) -> Path {
        Path { p in
            switch g {
            case 0: p.addRoundedRect(in: CGRect(x: x + 2, y: y + 2, width: 12, height: 12), cornerSize: CGSize(width: 3, height: 3)) // a task
            case 1: // a document
                p.addRoundedRect(in: CGRect(x: x + 3, y: y + 1.5, width: 10, height: 13), cornerSize: CGSize(width: 2, height: 2))
                p.move(to: CGPoint(x: x + 6, y: y + 6)); p.addLine(to: CGPoint(x: x + 10, y: y + 6))
                p.move(to: CGPoint(x: x + 6, y: y + 9.5)); p.addLine(to: CGPoint(x: x + 10, y: y + 9.5))
            case 2: // a meeting
                p.addRoundedRect(in: CGRect(x: x + 1.5, y: y + 2.5, width: 13, height: 12), cornerSize: CGSize(width: 3, height: 3))
                p.move(to: CGPoint(x: x + 1.5, y: y + 6.5)); p.addLine(to: CGPoint(x: x + 14.5, y: y + 6.5))
            default: p.addEllipse(in: CGRect(x: x + 5, y: y + 5, width: 6, height: 6)) // a bullet
            }
        }
    }
}
