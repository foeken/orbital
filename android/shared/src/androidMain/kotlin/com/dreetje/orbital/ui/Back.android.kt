package com.dreetje.orbital.ui

import androidx.activity.BackEventCompat
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import kotlinx.coroutines.CancellationException

// The activity's predictive back (androidx.activity PredictiveBackHandler): progress as the finger moves, signed by
// the edge it came from, then back or cancelled
@Composable
actual fun PlatformBack(enabled: Boolean, onProgress: (Float) -> Unit, onCancel: () -> Unit, onBack: () -> Unit) {
    val progress by rememberUpdatedState(onProgress)
    val cancel by rememberUpdatedState(onCancel)
    val back by rememberUpdatedState(onBack)
    PredictiveBackHandler(enabled) { events ->
        try {
            events.collect { e -> progress(if (e.swipeEdge == BackEventCompat.EDGE_RIGHT) -e.progress else e.progress) }
            back()
        } catch (e: CancellationException) {
            cancel()
            throw e
        }
    }
}
