package com.dreetje.orbital.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

// What SwiftUI's sheets and Form give the iPhone, built once for Android: a sheet, its bar, grouped rows and their
// choices

// A sheet over the page, as the iPhone's are: full height, the grouped background, closed by its own buttons, by a
// swipe down (unless swipe is false, as Quick Add's, the iPhone's interactiveDismissDisabled) or by Back. content gets
// close, which slides it away first.
@Composable
fun Sheet(onDismiss: () -> Unit, swipe: Boolean = true, content: @Composable ColumnScope.(close: () -> Unit) -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val close: () -> Unit = { scope.launch { state.hide() }.invokeOnCompletion { onDismiss() } }
    ModalBottomSheet(onDismiss, sheetState = state, sheetGesturesEnabled = swipe, containerColor = Theme.colors.grouped, dragHandle = null, contentWindowInsets = { WindowInsets.statusBars }) {
        Column(Modifier.fillMaxWidth().fillMaxHeight()) { content(close) }
    }
}

// A sheet's bar: what leaves it on the left (Cancel, or Back on a page inside it), its title, what it does on the right
@Composable
fun SheetBar(title: String, cancel: (() -> Unit)? = null, back: (() -> Unit)? = null, action: String? = null, enabled: Boolean = true, onAction: () -> Unit = {}) {
    val c = Theme.colors
    Box(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 4.dp)) {
        Row(Modifier.align(Alignment.CenterStart)) {
            if (back != null) IconButton(back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = c.text) }
            else if (cancel != null) TextButton(cancel) { Text("Cancel", color = c.text) }
        }
        Text(title, Modifier.align(Alignment.Center).padding(horizontal = 96.dp).semantics { heading() }, style = Type.headline, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
        if (action != null) TextButton(onAction, Modifier.align(Alignment.CenterEnd), enabled = enabled) {
            Text(action, fontWeight = FontWeight.SemiBold, color = if (enabled) c.text else c.tertiary)
        }
    }
}

// Rows in a rounded group under a grey heading, a line under the group's words, as the iPhone's Form sections
@Composable
fun Group(header: String? = null, footer: String? = null, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val c = Theme.colors
    Column(modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        if (header != null) Text(header, Modifier.padding(start = 16.dp, bottom = 6.dp).semantics { heading() }, style = Type.headline, color = c.secondary)
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.card), content = content)
        if (footer != null) Text(footer, Modifier.padding(start = 16.dp, end = 16.dp, top = 6.dp), style = Type.footnote, color = c.secondary)
    }
}

// One row of a group: its words and its value; a line under it unless it is the last
@Composable
fun GroupRow(modifier: Modifier = Modifier, last: Boolean = false, onClick: (() -> Unit)? = null, selected: Boolean? = null, content: @Composable RowScope.() -> Unit) {
    val c = Theme.colors
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth()
                .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
                .then(if (selected != null) Modifier.semantics { this.selected = selected } else Modifier)
                .heightIn(min = 50.dp).padding(horizontal = 16.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically, content = content,
        )
        if (!last) HorizontalDivider(Modifier.padding(start = 16.dp), color = c.separator)
    }
}

@Composable
fun Tick(on: Boolean) {
    if (on) Icon(Icons.Filled.Check, null, Modifier.size(20.dp), Theme.colors.text) else Spacer(Modifier.width(20.dp))
}

// One choice of a group: its words, ticked when it is the one, the whole row the button that picks it
@Composable
fun ChoiceRow(title: String, on: Boolean, last: Boolean, onClick: () -> Unit) =
    GroupRow(last = last, onClick = onClick, selected = on) { Text(title, Modifier.weight(1f), color = Theme.colors.text); Tick(on) }

@Composable
fun SearchField(query: String, set: (String) -> Unit, modifier: Modifier = Modifier) {
    val c = Theme.colors
    OutlinedTextField(query, set, modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), singleLine = true,
        placeholder = { Text("Search", color = c.secondary) }, leadingIcon = { Icon(Icons.Outlined.Search, null, tint = c.secondary) },
        shape = RoundedCornerShape(12.dp),
        colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = c.card, unfocusedContainerColor = c.card, focusedBorderColor = c.separator, unfocusedBorderColor = c.separator))
}
