package com.dreetje.orbital.ui

import androidx.compose.runtime.Composable

@Composable
actual fun PlatformBack(enabled: Boolean, onProgress: (progress: Float, fromRight: Boolean) -> Unit, onCancel: () -> Unit, onBack: () -> Unit) {}
