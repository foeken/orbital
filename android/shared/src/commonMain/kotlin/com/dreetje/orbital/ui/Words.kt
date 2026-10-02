package com.dreetje.orbital.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import com.dreetje.orbital.Row

// Zooming into a node from anywhere: a mention, a reference or a row (Shell pushes it, as the iPhone's openURL does)
val LocalZoom = staticCompositionLocalOf<(String?) -> Unit> { {} }

// Under a sensitive mark: every Words below draws its bars, and Faces draw no circles (ios/Orbital Blur, sensitiveHidden)
val LocalHidden = staticCompositionLocalOf { false }

// What is sensitive, drawn as the desktop draws it, until a shake of the phone shows it (Engine.reveal); TalkBack
// hears only that it is hidden, as the eye sees
@Composable
fun Sensitive(hidden: Boolean, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    if (!hidden) { Box(modifier) { content() }; return }
    Box(modifier.clearAndSetSemantics { contentDescription = "Sensitive, shake to show" }) {
        CompositionLocalProvider(LocalHidden provides true, content = content)
    }
}

// A row's words with their marks. A mention and a link to a node zoom into it; any other link opens as it would anywhere.
fun Row.styled(c: Colors, zoom: (String?) -> Unit): AnnotatedString = buildAnnotatedString {
    val list = segments?.takeIf { it.isNotEmpty() } ?: listOf(Row.Segment(text = words))
    for (s in list) {
        val text = s.text ?: s.mention?.label ?: ""
        val m = s.marks
        val style = SpanStyle(
            fontWeight = if (m?.bold == true) FontWeight.SemiBold else null,
            fontStyle = if (m?.italic == true) FontStyle.Italic else null,
            fontFamily = if (m?.code == true) FontFamily.Monospace else null,
            textDecoration = if (m?.strike == true) TextDecoration.LineThrough else null,
            color = if (m?.strike == true) c.secondary else Color.Unspecified,
        )
        val href = s.mention?.uri ?: m?.link
        val link = when {
            href == null -> null
            href.startsWith("tana:") -> LinkAnnotation.Clickable(href, TextLinkStyles(SpanStyle(color = c.link))) { zoom(href) }
            else -> LinkAnnotation.Url(href, TextLinkStyles(SpanStyle(color = c.link, textDecoration = TextDecoration.Underline)))
        }
        if (link != null) withLink(link) { withStyle(style) { append(text) } } else withStyle(style) { append(text) }
    }
}

// Words to read. Under a sensitive mark the desktop's bar (styles.css .sensitive): no letters, a grey bar through each
// line where they were, 0.72 em thick across the line-through.
@Composable
fun Words(
    text: AnnotatedString,
    modifier: Modifier = Modifier,
    style: TextStyle = Type.body,
    color: Color = Theme.colors.text,
    maxLines: Int = Int.MAX_VALUE,
    inline: Map<String, androidx.compose.foundation.text.InlineTextContent> = emptyMap(),
) {
    if (!LocalHidden.current) {
        Text(text, modifier, color = color, style = style, maxLines = maxLines, overflow = TextOverflow.Ellipsis, inlineContent = inline)
        return
    }
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    val bar = Theme.colors.redacted
    Text(
        AnnotatedString(text.text.replace("\uFFFD", "")), // an inline glyph's placeholder has no bar of its own
        modifier.drawBehind {
            val l = layout ?: return@drawBehind
            val em = style.fontSize.toPx()
            for (i in 0 until l.lineCount) {
                val left = l.getLineLeft(i)
                val right = l.getLineRight(i)
                if (right <= left) continue
                val top = l.getLineBaseline(i) - 0.3f * em - 0.36f * em
                drawRoundRect(bar, Offset(left, top), Size(right - left, 0.72f * em), CornerRadius(0.12f * em))
            }
        },
        color = Color.Transparent, style = style, maxLines = maxLines, onTextLayout = { layout = it },
    )
}

@Composable
fun Words(text: String, modifier: Modifier = Modifier, style: TextStyle = Type.body, color: Color = Theme.colors.text, maxLines: Int = Int.MAX_VALUE) =
    Words(AnnotatedString(text), modifier, style, color, maxLines)
