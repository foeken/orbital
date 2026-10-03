package com.dreetje.orbital.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

// Small pieces the screens share, each standing in for what SwiftUI gives the iPhone

// An empty page says what would fill it and how to start (ContentUnavailableView on the iPhone): a glyph, a title,
// a line, and what can be done
@Composable
fun Empty(title: String, message: String? = null, modifier: Modifier = Modifier, glyph: String? = null, icon: ImageVector? = null, actions: @Composable () -> Unit = {}) {
    val c = Theme.colors
    Column(modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally) {
        when {
            icon != null -> Icon(icon, null, Modifier.size(44.dp), c.tertiary)
            glyph != null -> Glyph(glyph, Modifier.size(44.dp), c.tertiary)
        }
        Text(title, style = Type.title3, color = c.text, textAlign = TextAlign.Center)
        if (message != null) Text(message, Modifier.widthIn(max = 420.dp), style = Type.subheadline, color = c.secondary, textAlign = TextAlign.Center)
        actions()
    }
}

// What went wrong, in a grey band at the foot of a page or a sheet, the page still there over it
@Composable
fun Notice(text: String, modifier: Modifier = Modifier) {
    val c = Theme.colors
    Text(text, modifier.fillMaxWidth().background(c.card).padding(8.dp), style = Type.footnote, color = c.secondary, textAlign = TextAlign.Center)
}

// A round button: a filled disc of this size with its glyph in the middle, read out by its label (send, dictating,
// the listening bar's ✕ and ■, settings at the foot of the menu); border: a hairline round it
@Composable
fun RoundButton(label: String, size: Dp, fill: Color, modifier: Modifier = Modifier, border: Color? = null, enabled: Boolean = true, onClick: () -> Unit, content: @Composable BoxScope.() -> Unit) {
    Box(modifier.size(size).clip(CircleShape).background(fill).then(if (border != null) Modifier.border(1.dp, border, CircleShape) else Modifier)
        .clickable(enabled = enabled, onClick = onClick).semantics { contentDescription = label; role = Role.Button }, contentAlignment = Alignment.Center, content = content)
}

// A glyph or a box lined up with the first line of the words beside it, in a Row aligned by baseline: its bottom this
// far under their baseline (negative: above it), as SwiftUI's .alignmentGuide(.firstTextBaseline) { $0[.bottom] - by }
@Composable
fun RowScope.onBaseline(by: Dp, modifier: Modifier = Modifier): Modifier {
    val px = with(LocalDensity.current) { by.roundToPx() }
    return modifier.alignBy { it.measuredHeight - px }
}

// Keys for a lazy list from what each row shows, as the iPhone's ForEach is by id, so a row added above keeps the
// rest (an open menu, a write in flight, the scroll); one shown twice gets a count after it, where a repeated key
// would crash the list
fun uniqueKeys(): (String) -> String {
    val seen = mutableMapOf<String, Int>()
    return { k -> val n = (seen[k] ?: 0) + 1; seen[k] = n; if (n == 1) k else "$k#$n" }
}
