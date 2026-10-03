package com.dreetje.orbital.android

import android.content.Intent
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

// The real engine on this device's WebView: the iPhone's engine.js (Orbital's SDK, Loro's WASM inside) loads on Tana's
// session page, says ready, and asks Tana whether anyone is signed in. On a device that never signed in that ends on
// Tana's own sign-in, so this needs the network and nobody's account; it reads nothing and writes nothing.
@RunWith(AndroidJUnit4::class)
@LargeTest
class EngineBootTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun theEngineStartsAndAsksTanaForTheSession() {
        awake(androidx.test.uiautomator.UiDevice.getInstance(androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()))
        ActivityScenario.launch<MainActivity>(Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)).use {
            // signed in already (a device someone uses), the Timeline; otherwise Tana's sign-in
            compose.waitUntil(90_000) {
                listOf("Sign in to Tana", "Today", "Nothing yet", "Show three more days").any { t -> compose.onAllNodes(hasText(t, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
            }
            check(compose.onAllNodes(hasText("Can't reach Tana"), useUnmergedTree = true).fetchSemanticsNodes().isEmpty()) { "the engine did not start" }
        }
    }
}
