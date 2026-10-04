package com.dreetje.orbital.ui

import androidx.compose.runtime.Composable
import kotlin.math.abs

// The system's Back: the gesture, predictive back included, or the button. On Android the activity's; nothing on the
// desktop. While a gesture is under the finger, onProgress hears how far it has come, from 0 to 1, and whether it came
// from the right edge; then onBack if it was let go to go back, or onCancel if it was taken back. The button sends
// onBack alone.
@Composable
expect fun PlatformBack(
    enabled: Boolean,
    onProgress: (progress: Float, fromRight: Boolean) -> Unit = { _, _ -> },
    onCancel: () -> Unit = {},
    onBack: () -> Unit,
)

// the open menu under a back gesture: the page slides home as the finger moves
internal fun predictiveDrawerOffset(startOffset: Float, progress: Float): Float =
    startOffset * (1f - abs(progress).coerceIn(0f, 1f))
