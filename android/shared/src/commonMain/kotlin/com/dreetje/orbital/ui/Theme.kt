package com.dreetje.orbital.ui

import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.spring
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.PI

// The iPhone's colours, type and rail (ios/Orbital/Timeline.swift Rail, Color.pair, and the system's own)

// Orbital's colours, the desktop's light ones and their dark twins (styles.css and its [data-theme="dark"] rules, as
// ios/Orbital Color.pair has them): grey unless colour means something. Green is done, blue is a link or something
// happening now, red is an error or leaving, orange a warning. Dark is not an inversion: the page and the menu behind it
// are black, as the iPhone's Color(.systemBackground) is, and the rest the desktop's charcoal greys.
@Immutable
class Colors(
    val dark: Boolean,
    val page: Color, // the page, and the side menu behind it
    val grouped: Color, // behind a sheet's grouped rows (Settings, Quick Add)
    val card: Color, // a group of rows, a menu, the composer
    val text: Color,
    val secondary: Color, // passes AA on page and card (styles.css --muted)
    val tertiary: Color, // glyphs and placeholders only, never words to read
    val separator: Color,
    val fill: Color, // a selected menu row, a chip, an empty send button
    val fillQuiet: Color, // a code block
    val accent: Color, // focus and things happening now: the new dot, send, a meeting under way
    val link: Color,
    val done: Color,
    val checkOn: Color,
    val checkOff: Color,
    val checkInbox: Color,
    val face: Color,
    val bubble: Color,
    val bubbleText: Color,
    val redacted: Color, // styles.css .sensitive: #696d73 at 14 %
    val warning: Color,
    val danger: Color,
)

// public for what draws in the same colours outside Compose UI: the widgets (androidApp Widgets.kt)
val Light = Colors(
    dark = false, page = Color(0xFFFFFFFF), grouped = Color(0xFFF2F2F4), card = Color(0xFFFFFFFF), text = Color(0xFF1A1A1A),
    secondary = Color(0xFF666666), tertiary = Color(0xFFA3A3A8), separator = Color(0xFFE2E2E4), fill = Color(0xFFEEEEF0),
    fillQuiet = Color(0xFFF4F4F6), accent = Color(0xFF007AFF), link = Color(0xFF3F7EAA), done = Color(0xFF5A9670),
    checkOn = Color(0xFF6FAE82), checkOff = Color(0xFFE4E4E4), checkInbox = Color(0xFFC8C8C8), face = Color(0xFFE5E5EA),
    bubble = Color(0xFFEAF3FD), bubbleText = Color(0xFF1B2B41), redacted = Color(0xFF696D73).copy(alpha = 0.14f),
    warning = Color(0xFFA15C00), danger = Color(0xFFC62828),
)

val Dark = Colors(
    dark = true, page = Color.Black, grouped = Color(0xFF121314), card = Color(0xFF242729), text = Color(0xFFE3E4E5),
    secondary = Color(0xFFA0A5A8), tertiary = Color(0xFF6B7073), separator = Color(0xFF34383A), fill = Color(0xFF2C3032),
    fillQuiet = Color(0xFF232628), accent = Color(0xFF0A84FF), link = Color(0xFF7FB8DD), done = Color(0xFF5A9670),
    checkOn = Color(0xFF5B976C), checkOff = Color(0xFF3A3E40), checkInbox = Color(0xFF5D6467), face = Color(0xFF33373A),
    bubble = Color(0xFF1E3D7B), bubbleText = Color(0xFFE8EEFF), redacted = Color(0xFF8C9196).copy(alpha = 0.22f),
    warning = Color(0xFFF0A33C), danger = Color(0xFFF28B82),
)

// The iPhone's sizes, a step smaller as Android's own are: body, subheadline, footnote, headline, title2 and title3
object Type {
    val body = TextStyle(fontSize = 16.sp, lineHeight = 22.sp)
    val subheadline = TextStyle(fontSize = 14.sp, lineHeight = 19.sp)
    val footnote = TextStyle(fontSize = 13.sp, lineHeight = 17.sp)
    val headline = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold)
    val title2 = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold)
    val title3 = TextStyle(fontSize = 19.sp, lineHeight = 25.sp, fontWeight = FontWeight.Bold)
}

// The Timeline's rail (ios/Orbital/Timeline.swift Rail): the time column, the marker's, and where the line runs
object Rail {
    val inset = 12.dp
    val time = 42.dp
    val marker = 24.dp
    val gap = 10.dp
    // above the days: no time column, the markers centred under the menu button (the top bar's 4 dp in, then half its
    // 48 dp button: 28 dp); the iPhone's is under its own (Timeline.swift Rail.left)
    val left = 17.dp
    val leftMarker = 22.dp
}

// the time column as wide as "00:00" is at this phone's font size, the iPhone's 42 at least: at Android's larger
// sizes (1.3 on a Galaxy) 42 cut "23:34" to "23:3"
val LocalRailTime = staticCompositionLocalOf { Rail.time }

val LocalColors = staticCompositionLocalOf { Light }

// How much of the page's foot a floating composer covers (the iPhone's .safeAreaInset(edge: .bottom)): a list under it
// scrolls on past it by this much, so its last row can still come up above the composer
val LocalBottomInset = staticCompositionLocalOf { 0.dp }

// SwiftUI's springs, which the iPhone's moves are written in, as Compose springs: SwiftUI's bounce b is a damping ratio
// of 1 - b, and its duration d (the time to settle, near enough) a stiffness of (2π / d)². .snappy is bounce 0.15 and
// half a second; the menu's move is .snappy(duration: 0.3) (Shell.swift move). .smooth has no bounce: a page pushed.
fun <T> snappy(duration: Float = 0.5f): SpringSpec<T> = spring(0.85f, stiffness(duration))
fun <T> smooth(duration: Float = 0.5f): SpringSpec<T> = spring(1f, stiffness(duration))
private fun stiffness(duration: Float) = (2 * PI / duration).let { it * it }.toFloat()

object Theme {
    val colors: Colors @Composable get() = LocalColors.current
}

@Composable
fun OrbitalTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val c = if (dark) Dark else Light
    // controls in the text colour, not an accent, as the ChatGPT app and the iPhone's .tint(.primary) have them
    val scheme = (if (dark) darkColorScheme() else lightColorScheme()).copy(
        primary = c.text, onPrimary = c.page, primaryContainer = c.fill, onPrimaryContainer = c.text,
        secondary = c.secondary, onSecondary = c.page, secondaryContainer = c.fill, onSecondaryContainer = c.text,
        background = c.page, onBackground = c.text, surface = c.page, onSurface = c.text, surfaceVariant = c.fill, onSurfaceVariant = c.secondary,
        surfaceContainerLowest = c.page, surfaceContainerLow = c.card, surfaceContainer = c.card, surfaceContainerHigh = c.card, surfaceContainerHighest = c.fill,
        surfaceBright = c.card, surfaceDim = c.grouped, inverseSurface = c.text, inverseOnSurface = c.page,
        outline = c.separator, outlineVariant = c.separator, error = c.danger, onError = c.page, scrim = Color.Black,
    )
    // Material's own pieces (a menu, a dialog, a button's words) in the app's sizes rather than Material's
    val type = Typography(bodyLarge = Type.body, bodyMedium = Type.body, bodySmall = Type.footnote, labelLarge = Type.body,
        titleLarge = Type.title2, titleMedium = Type.title3, titleSmall = Type.headline, headlineSmall = Type.title2)
    CompositionLocalProvider(LocalColors provides c) {
        MaterialTheme(colorScheme = scheme, typography = type, content = content)
    }
}
