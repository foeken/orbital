package com.dreetje.orbital.ui

import androidx.compose.runtime.Composable
import kotlin.math.abs

// The system's Back: the gesture, predictive back included, or the button. On Android the activity's; nothing on the
// desktop. While a gesture is under the finger, onProgress hears how far it has come, from 0 to 1 from the left edge
// and to -1 from the right; then onBack if it was let go to go back, or onCancel if it was taken back. The button sends
// onBack alone.
@Composable
expect fun PlatformBack(
    enabled: Boolean,
    onProgress: (Float) -> Unit = {},
    onCancel: () -> Unit = {},
    onBack: () -> Unit,
)

// A page leaving under a back gesture, as the iPhone's NavigationStack swipe moves it: the page on top follows the
// finger toward the edge it is pulled to, the one under it comes in from a quarter of the way off the other side,
// a little dimmed until it is all there. The page on top stays opaque, so the one under it never shows through.
internal data class BackMotion(
    val currentTranslation: Float, // of the page's width
    val previousTranslation: Float,
    val previousAlpha: Float,
)

internal fun backMotion(progress: Float): BackMotion {
    val signed = progress.coerceIn(-1f, 1f)
    val distance = abs(signed)
    val direction = if (signed < 0f) -1f else 1f
    return BackMotion(
        currentTranslation = signed,
        previousTranslation = -0.25f * (1f - distance) * direction,
        previousAlpha = 0.88f + 0.12f * distance,
    )
}

// the open menu under a back gesture: the page slides home as the finger moves, from either edge
internal fun predictiveDrawerOffset(startOffset: Float, progress: Float): Float =
    startOffset * (1f - abs(progress).coerceIn(0f, 1f))
