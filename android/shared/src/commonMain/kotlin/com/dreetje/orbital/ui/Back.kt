package com.dreetje.orbital.ui

import androidx.compose.runtime.Composable

// The system's Back (the gesture, predictive back included, or the button): the activity's on Android, nothing on the desktop
@Composable
expect fun PlatformBack(enabled: Boolean, onBack: () -> Unit)
