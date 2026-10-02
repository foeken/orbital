package com.dreetje.orbital.ui

import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.graphics.vector.group
import androidx.compose.ui.unit.dp

// The Nucleo line glyphs the desktop and the iPhone draw (icons.js, GlyphData.kt), as vectors tinted like Material
// icons: one grey everywhere unless the colour means something
object Glyphs {
    private val built = mutableMapOf<String, ImageVector>()

    operator fun get(name: String): ImageVector = built.getOrPut(name) {
        val g = GLYPHS[name] ?: GLYPHS.getValue("doc")
        ImageVector.Builder(name, 18.dp, 18.dp, g.w, g.h).apply {
            group(translationX = -g.x, translationY = -g.y) {
                for (p in g.parts) addPath(
                    addPathNodes(p.d),
                    fill = if (p.fill) SolidColor(Color.Black) else null,
                    stroke = if (p.stroke > 0f) SolidColor(Color.Black) else null,
                    strokeLineWidth = p.stroke,
                    strokeLineCap = when (p.cap) { "round" -> StrokeCap.Round; "square" -> StrokeCap.Square; else -> StrokeCap.Butt },
                    strokeLineJoin = when (p.join) { "round" -> StrokeJoin.Round; "bevel" -> StrokeJoin.Bevel; else -> StrokeJoin.Miter },
                )
            }
        }.build()
    }

    // the desktop's glyph for a node's kind (main/rows.js): a meeting by its calendar
    fun of(kind: String?): String = when (kind) {
        "event" -> "calendar"
        "space" -> "space"
        "user-profile" -> "member"
        "chat" -> "discuss"
        "search" -> "search"
        else -> "doc"
    }

    fun ofUri(uri: String): String = of(com.dreetje.orbital.kindOf(uri))
}

@Composable
fun Glyph(name: String, modifier: Modifier = Modifier, tint: Color = LocalContentColor.current, description: String? = null) =
    Icon(Glyphs[name], description, modifier, tint)
