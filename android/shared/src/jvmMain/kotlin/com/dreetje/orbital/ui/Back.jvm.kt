package com.dreetje.orbital.ui

import androidx.compose.runtime.Composable

@Composable
actual fun PlatformBack(enabled: Boolean, onProgress: (Float) -> Unit, onCancel: () -> Unit, onBack: () -> Unit) {}
