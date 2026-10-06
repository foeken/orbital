package com.dreetje.orbital

import kotlin.test.Test
import kotlin.test.assertEquals

// The launcher's shortcuts (Glimpse.kt forShortcuts); the Activity widget's lines are in ios/PhoneSpec.json (SpecTest)
class GlimpseTest {
    // the launcher's shortcuts: the first still to do, never one done or hidden, as many as there is room for
    @Test fun theLaunchersTasksAreTheFirstStillToDo() {
        val tasks = listOf(Row("a", title = "Done", stateType = "closed"), Row("b", title = "Secret", stateType = "open", sensitive = true),
            Row("c", title = "Book the venue", stateType = "open"), Row("d", title = "Inbox one", stateType = "proposed"), Row("e", title = "Later", stateType = "not_now"))
        assertEquals(listOf("c", "d"), tasks.forShortcuts(2).map { it.id })
        assertEquals(emptyList(), tasks.forShortcuts(0))
    }

    // each task's shortcuts, as the iPhone's Shortcuts offer it: open it, Check Off, and Pin to Today or, pinned, Remove Pin;
    // a task's three together, and a task only when all three fit
    @Test fun eachTaskIsOpenedCheckedOffAndPinnedFromTheLauncher() {
        val tasks = listOf(Row("tana:text:c", title = "Book the venue", stateType = "open"), Row("tana:text:d", title = "Inbox one", stateType = "proposed"))
        assertEquals(listOf("orbital:tana:text:c", "orbital:check:tana:text:c", "orbital:unpin:tana:text:c", "orbital:tana:text:d", "orbital:check:tana:text:d", "orbital:pin:tana:text:d"),
            tasks.shortcuts(7, pinned = setOf("tana:text:c")).map { it.link })
        assertEquals(listOf("Book the venue", "Check off Book the venue", "Pin to Today Book the venue"), tasks.shortcuts(5, emptySet()).map { it.label })
        assertEquals(emptyList(), tasks.shortcuts(2, emptySet()))
    }
}
