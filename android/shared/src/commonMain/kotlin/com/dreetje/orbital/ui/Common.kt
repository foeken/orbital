package com.dreetje.orbital.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

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
