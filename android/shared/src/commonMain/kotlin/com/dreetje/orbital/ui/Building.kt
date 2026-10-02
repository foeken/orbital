package com.dreetje.orbital.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

// Loading, as the desktop's (renderer/loading.js) and the iPhone's (Building.swift): while the Timeline's first rows
// are on their way, the page builds itself where they will be, row by row, each a small outlined glyph rising in and a
// rounded bar for its words growing in from the left, with a soft band of light running through the bars. The same
// page on every launch; nothing drawn for the first 0.3 s, so a quick load never blinks it; one still, built frame with
// animations off. One colour at a few strengths, so it follows the theme.
@Composable
fun Building(still: Boolean) {
    val c = Theme.colors
    var t by remember { mutableStateOf(if (still) 99.0 else -0.3) }
    if (!still) LaunchedEffect(Unit) {
        val start = withFrameNanos { it }
        while (true) withFrameNanos { now -> t = (now - start) / 1e9 - 0.3 }
    }
    Canvas(
        Modifier.fillMaxSize()
            .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
            // it thins out down the page
            .drawWithContent { drawContent(); drawRect(Brush.verticalGradient(0.3f to Color.Black, 0.85f to Color.Transparent), blendMode = BlendMode.DstIn) }
            .semantics { contentDescription = "Loading" },
    ) {
        if (t < 0) return@Canvas
        val dp = density
        val base = c.text.copy(alpha = 0.55f)
        for (it in items(size.width / dp, size.height / dp)) {
            val p = (t - it.start) / it.dur
            if (p <= 0) continue
            val eased = 1 - (1 - min(1.0, p)).pow(3)
            val a = (it.a / 0.55 * min(1.0, p * 2.5)).toFloat()
            if (it.glyph != null) {
                drawPath(glyph(it.glyph, it.x * dp, (it.y + 3 * (1 - eased)) * dp, dp), base.copy(alpha = base.alpha * a), style = Stroke(1.5f * dp))
                continue
            }
            val w = max(it.h, it.w * eased) * dp
            val bar = Path().apply { addRoundRect(RoundRect(Rect(Offset((it.x * dp).toFloat(), (it.y * dp).toFloat()), Size(w.toFloat(), (it.h * dp).toFloat())), CornerRadius((it.h / 2 * dp).toFloat()))) }
            if (still) { drawPath(bar, base, alpha = a); continue }
            // the band of light, the rows lower down a step behind the ones above
            val phase = (((t / 1.8 - it.y / 900) % 1) + 1) % 1
            val bx = (it.x - 160 + phase * (it.w + 320)) * dp
            drawPath(bar, Brush.horizontalGradient(listOf(base, c.text, base), (bx - 120 * dp).toFloat(), (bx + 120 * dp).toFloat()), alpha = a)
        }
    }
}

private class Item(val x: Double, val y: Double, val w: Double, val h: Double, val a: Double, val start: Double, val dur: Double, val glyph: Int? = null)
private class Line(var head: Boolean, val glyph: Int, val w: Double, val meta: Double)

// loading.js ROWS, from its seed: section headings now and then, never two together, some rows with a second line
private val lines: List<Line> = run {
    var seed = 20260926.0
    fun rnd(): Double { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
    val out = (0 until 30).map { i ->
        val head = i == 0 || (i > 2 && rnd() < 0.12)
        val glyph = (rnd() * 4).toInt()
        val w = 0.3 + 0.5 * rnd()
        val meta = if (rnd() < 0.5) 0.2 + 0.3 * rnd() else 0.0
        Line(head, glyph, w, meta)
    }
    for (i in 1 until out.size) if (out[i - 1].head) out[i].head = false
    out
}

// where each part goes on the Timeline's rail (time, marker, words), and when it comes in; in dp
private fun items(width: Float, height: Float): List<Item> {
    val out = mutableListOf<Item>()
    var y = 16.0
    var s = 0.1
    val inset = Rail.inset.value.toDouble(); val time = Rail.time.value.toDouble(); val gap = Rail.gap.value.toDouble(); val marker = Rail.marker.value.toDouble()
    val words = inset + time + gap + marker + gap
    val avail = max(120.0, width - words - 24)
    for (l in lines) {
        if (y >= height) break
        if (l.head) {
            y += if (y > 16) 18.0 else 0.0
            out += Item(20.0, y + 12, 60 + l.w * 50, 9.0, 0.08, s, 0.5)
            y += 44; s += 0.08; continue
        }
        out += Item(inset + time - 32, y + 4, 32.0, 8.0, 0.06, s, 0.4)
        out += Item(inset + time + gap + 4, y, 16.0, 16.0, 0.26, s, 0.4, l.glyph)
        out += Item(words, y + 3, max(40.0, avail * l.w), 11.0, 0.11, s + 0.08, 0.8)
        if (l.meta > 0) { out += Item(words, y + 25, avail * l.meta, 9.0, 0.065, s + 0.4, 0.5); y += 22 }
        y += 44; s += 0.09
    }
    return out
}

// 16 dp, the size of a row's marker: a task, a document, a meeting, a bullet
private fun glyph(g: Int, x: Double, y: Double, dp: Float): Path {
    fun f(v: Double) = v.toFloat()
    val u = dp.toDouble()
    return Path().apply {
        fun rr(l: Double, t: Double, w: Double, h: Double, r: Double) = addRoundRect(RoundRect(Rect(Offset(f(x + l * u), f(y + t * u)), Size(f(w * u), f(h * u))), CornerRadius(f(r * u))))
        fun line(x1: Double, y1: Double, x2: Double, y2: Double) { moveTo(f(x + x1 * u), f(y + y1 * u)); lineTo(f(x + x2 * u), f(y + y2 * u)) }
        when (g) {
            0 -> rr(2.0, 2.0, 12.0, 12.0, 3.0)
            1 -> { rr(3.0, 1.5, 10.0, 13.0, 2.0); line(6.0, 6.0, 10.0, 6.0); line(6.0, 9.5, 10.0, 9.5) }
            2 -> { rr(1.5, 2.5, 13.0, 12.0, 3.0); line(1.5, 6.5, 14.5, 6.5) }
            else -> addOval(Rect(Offset(f(x + 5 * u), f(y + 5 * u)), Size(f(6 * u), f(6 * u))))
        }
    }
}
