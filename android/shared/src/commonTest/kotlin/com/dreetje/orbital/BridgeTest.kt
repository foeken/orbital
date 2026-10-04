package com.dreetje.orbital

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

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

    // what the page posts back, as script() has it post: a call's value or what it threw, by its number
    @Test fun answersAreReadByTheirNumber() {
        assertEquals(Bridge.Heard.Said("changed"), Bridge.read("changed"))
        assertEquals(Bridge.Heard.Answer(3, JsonPrimitive("[]"), null), Bridge.read("""{"id":3,"ok":true,"value":"[]"}"""))
        assertEquals(Bridge.Heard.Answer(4, JsonNull, null), Bridge.read("""{"id":4,"ok":true}"""))
        assertEquals(Bridge.Heard.Answer(5, null, "not authenticated"), Bridge.read("""{"id":5,"ok":false,"error":"not authenticated"}"""))
        assertNull(Bridge.read("""{"ok":true}""")) // no number: nobody's answer
        assertNull(Bridge.read("{not json"))
    }

    @Test fun onlyTanasOwnPageIsHeard() {
        assertTrue(Bridge.trusted("https://home.tana.inc", mainFrame = true))
        assertTrue(Bridge.trusted("https://home.tana.inc/", mainFrame = true))
        assertFalse(Bridge.trusted("https://home.tana.inc", mainFrame = false)) // a frame inside the page
        assertFalse(Bridge.trusted("https://home.tana.inc.example.com", mainFrame = true))
        assertFalse(Bridge.trusted("http://home.tana.inc", mainFrame = true))
        assertFalse(Bridge.trusted(null, mainFrame = true))
    }

    @Test fun onlyTheSessionPage() {
        assertTrue(Bridge.onSessionPage("https://home.tana.inc/api/auth/session"))
        assertTrue(Bridge.onSessionPage("https://home.tana.inc/api/auth/session?refresh=true"))
        assertFalse(Bridge.onSessionPage("https://home.tana.inc/")) // Tana's sign-in, in the same view
        assertFalse(Bridge.onSessionPage("https://home.tana.inc/api/auth/session/other"))
        assertFalse(Bridge.onSessionPage("https://evil.example/api/auth/session"))
        assertFalse(Bridge.onSessionPage("http://home.tana.inc/api/auth/session"))
        assertFalse(Bridge.onSessionPage(null))
    }
}
