package com.dreetje.orbital

import com.dreetje.orbital.ui.backMotion
import com.dreetje.orbital.ui.predictiveDrawerOffset
import com.dreetje.orbital.ui.snappy
import kotlin.test.Test
import kotlin.test.assertEquals

class BackMotionTest {
    @Test fun rightEdgeMovesTheCurrentPageTowardTheFinger() {
        val motion = backMotion(-0.4f)

        assertEquals(-0.4f, motion.currentTranslation, 0.001f)
        assertEquals(0.15f, motion.previousTranslation, 0.001f)
        assertEquals(0.928f, motion.previousAlpha, 0.001f)
    }

    @Test fun leftEdgeUsesTheMirroredPageTransition() {
        val motion = backMotion(0.4f)

        assertEquals(0.4f, motion.currentTranslation, 0.001f)
        assertEquals(-0.15f, motion.previousTranslation, 0.001f)
        assertEquals(0.928f, motion.previousAlpha, 0.001f)
    }

    @Test fun drawerBackProgressClosesFromEitherSystemEdge() {
        assertEquals(180f, predictiveDrawerOffset(300f, 0.4f), 0.001f)
        assertEquals(180f, predictiveDrawerOffset(300f, -0.4f), 0.001f)
        assertEquals(0f, predictiveDrawerOffset(300f, 1.2f), 0.001f)
    }

    // the iPhone's menu move, Animation.snappy(duration: 0.3): bounce 0.15 over 0.3 s
    @Test fun snappyIsSwiftUIsSpringInComposeTerms() {
        val menu = snappy<Float>(0.3f)
        assertEquals(0.85f, menu.dampingRatio, 0.001f)
        assertEquals(438.6f, menu.stiffness, 0.5f)
    }
}
