package com.dreetje.orbital

import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class BridgeTest {
    @Test fun argumentsGoInAsOneJsonStringNeverAsCode() {
        val s = Bridge.script(7, "return await orbital.ask(text)", mapOf("text" to "\"); alert(1); (\"\n\u2028"))
        // the words only ever appear inside the escaped JSON literal handed to JSON.parse
        assertTrue("(async ({ text }) =>" in s)
        assertTrue("JSON.parse(\"{\\\"text\\\":\\\"\\\\\\\"); alert(1); (\\\\\\\"\\\\n" in s, s)
        assertTrue("id: 7, ok: true" in s && "id: 7, ok: false" in s)
    }

    @Test fun onlyNamesAreArgumentNames() {
        assertFailsWith<IllegalArgumentException> { Bridge.script(1, "", mapOf("a b" to 1)) }
    }

    @Test fun theShimHandsWhatTheEngineSaysToTheListener() {
        assertTrue("messageHandlers: { orbital: { postMessage" in Bridge.SHIM && Bridge.LISTENER in Bridge.SHIM)
    }
}
