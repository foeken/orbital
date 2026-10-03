package com.dreetje.orbital.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import androidx.core.graphics.PathParser

// A glyph drawn black into a square bitmap, for what cannot draw a Compose vector: the widgets, whose RemoteViews tint
// it (androidApp Widgets.kt). The same paths the app draws (GlyphData.kt), each size drawn once.
private val drawn = mutableMapOf<Pair<String, Int>, Bitmap>()

fun glyphBitmap(name: String, px: Int): Bitmap = synchronized(drawn) {
    drawn.getOrPut(name to px) {
        val g = GLYPHS[name] ?: GLYPHS.getValue("doc")
        Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888).also { bitmap ->
            val canvas = Canvas(bitmap)
            canvas.scale(px / g.w, px / g.h)
            canvas.translate(-g.x, -g.y)
            for (p in g.parts) {
                val path = PathParser.createPathFromPathData(p.d)
                if (p.fill) canvas.drawPath(path, Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL })
                if (p.stroke > 0f) canvas.drawPath(path, Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    style = Paint.Style.STROKE
                    strokeWidth = p.stroke
                    strokeCap = when (p.cap) { "round" -> Paint.Cap.ROUND; "square" -> Paint.Cap.SQUARE; else -> Paint.Cap.BUTT }
                    strokeJoin = when (p.join) { "round" -> Paint.Join.ROUND; "bevel" -> Paint.Join.BEVEL; else -> Paint.Join.MITER }
                })
            }
        }
    }
}
