package com.dreetje.orbital

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Instant

@OptIn(ExperimentalCoroutinesApi::class)
class EngineTest {
    private val timeline = """[{"id":"s:e1","segments":[{"text":"An AI agent added a task"}],"createdAt":"2026-10-02T09:00:00Z","timeline":{"tone":"new"},
        "children":[{"id":"tana:text:a","title":"Draft the plan","stateType":"open"}]}]"""
    private var clock = Instant.parse("2026-10-02T10:00:00Z")

    // a page that is signed in and answers the Timeline; toggle answers what it is told to
    private fun page(setup: suspend () -> JsonElement = { text("""{"sensitive":["tana:text:a"],"pinned":[]}""") }, toggle: () -> String = { "\"closed\"" }) = FakeHost { body, _ ->
        when {
            "orbital.connect()" in body -> JsonPrimitive(true)
            "orbital.why()" in body -> text("200 signed in")
            "orbital.email()" in body -> text("me@example.com")
            "orbital.timeline" in body -> text(timeline)
            "orbital.setup()" in body -> setup()
            "orbital.issues()" in body -> kotlinx.serialization.json.JsonArray(emptyList())
            "orbital.toggle" in body -> text(toggle())
            "orbital.remove" in body -> throw Exception("You cannot delete this")
            "orbital.open" in body -> text("""{"title":"Plan","kind":"text","rows":[]}""")
            else -> JsonNull
        }
    }

    private fun TestScope.ready(host: FakeHost, platform: FakePlatform = FakePlatform()): Engine {
        val engine = Engine(host, platform, backgroundScope, now = { clock })
        engine.start()
        host.listener!!.said("ready")
        runCurrent() // the engine's own coroutines (backgroundScope), which advanceUntilIdle leaves alone
        return engine
    }

    @Test fun readyConnectsAndReadsTheTimeline() = runTest {
        val host = page()
        val engine = ready(host)
        assertEquals(listOf(Engine.SESSION), host.loaded)
        assertEquals(Engine.Phase.Ready, engine.phase)
        assertEquals("me@example.com", engine.email)
        assertEquals("s:e1", engine.rows.single().id)
        assertEquals(setOf("tana:text:a"), engine.sensitiveIds)
        assertTrue(engine.log.any { it.endsWith("engine: session 200 signed in") })
        // the pages and demo flag go in as arguments, never as code
        val call = host.calls.first { "orbital.timeline" in it.first }
        assertEquals(mapOf("pages" to 1, "demo" to false), call.second)
    }

    @Test fun signedOutShowsTanasSignIn() = runTest {
        val host = FakeHost { body, _ -> if ("orbital.connect()" in body) JsonPrimitive(false) else text("401 signed out") }
        val engine = ready(host)
        assertEquals(Engine.Phase.SignedOut, engine.phase)
        assertEquals(Engine.HOME, host.loaded.last())
    }

    @Test fun aFailedStartSaysWhy() = runTest {
        val host = page()
        val engine = Engine(host, FakePlatform(), backgroundScope, now = { clock })
        engine.start()
        host.listener!!.failed("net::ERR_INTERNET_DISCONNECTED")
        assertEquals(Engine.Phase.Failed("net::ERR_INTERNET_DISCONNECTED"), engine.phase)
    }

    @Test fun aTickShowsAtOnceAndStaysUntilTanaAgrees() = runTest {
        val engine = ready(page())
        val task = engine.rows.single().children!!.single()
        engine.toggle(task)
        assertEquals("closed", engine.state(task))
        // Tana still says open a moment later: the tick stays
        clock += 5.seconds
        engine.refresh()
        assertEquals("closed", engine.state(task))
        // half a minute on it still disagrees: Tana wins
        clock += 30.seconds
        engine.refresh()
        assertEquals("open", engine.state(task))
    }

    @Test fun aRefusedTickGoesBackWithTheReason() = runTest {
        val engine = ready(page { throw Exception("Tana refused the change: this task is read-only to you") })
        val task = engine.rows.single().children!!.single()
        engine.toggle(task)
        assertEquals("open", engine.state(task))
        assertEquals("Tana refused the change: this task is read-only to you", engine.error)
    }

    // the screen that asked for a read went away halfway through it (a LaunchedEffect restarted, a row left the list):
    // the next refresh still reads, where a loading flag left set made every later one only say "again"
    @Test fun aReadCutOffMidwayLeavesTheNextOneFree() = runTest {
        var stall = false
        val host = page(setup = { if (stall) awaitCancellation(); text("""{"sensitive":[],"pinned":[]}""") })
        val engine = ready(host)
        stall = true
        val cut = launch { engine.refresh() }
        runCurrent()
        assertTrue(engine.loading)
        cut.cancel()
        runCurrent()
        assertFalse(engine.loading)
        stall = false
        val reads = host.calls.count { "orbital.timeline" in it.first }
        engine.refresh()
        assertEquals(reads + 1, host.calls.count { "orbital.timeline" in it.first })
    }

    @Test fun aPageOpenedBeforeIsThereAtOnceUntilSigningOut() = runTest {
        val engine = ready(page())
        assertNull(engine.cached("tana:text:p"))
        engine.open("tana:text:p")
        assertEquals("Plan", engine.cached("tana:text:p")?.title)
        engine.demo = true // its words were read as they are: gone with demo mode turned on
        assertNull(engine.cached("tana:text:p"))
        engine.open("tana:text:p")
        engine.signOut()
        assertNull(engine.cached("tana:text:p"))
    }

    @Test fun sharedWordsComeOnceEachALineApiece() {
        assertEquals("Offsite venues\nhttps://example.com/v", Engine.Shared.words(" Offsite venues ", "https://example.com/v"))
        assertEquals("https://example.com/v", Engine.Shared.words("https://example.com/v", "https://example.com/v"))
        assertNull(Engine.Shared.words(null, "  "))
    }

    @Test fun demoModeTicksNothing() = runTest {
        val host = page()
        val engine = Engine(host, FakePlatform(), backgroundScope, demoMode = true, now = { clock })
        val task = Row("tana:text:a", stateType = "open")
        engine.toggle(task)
        assertEquals("open", engine.state(task))
        assertTrue(host.calls.none { "orbital.toggle" in it.first })
    }

    @Test fun aRefusedDeleteBringsTheRowBack() = runTest {
        val engine = ready(page())
        assertFalse(engine.remove("tana:text:a"))
        assertTrue(engine.removed.isEmpty())
        assertEquals("You cannot delete this", engine.error)
    }

    @Test fun shownLeavesOutWhatWasDeletedHere() = runTest {
        val engine = Engine(null, FakePlatform(), backgroundScope, sample = "[]" to "{}")
        engine.remove("tana:text:a") // the sample: gone here, nothing written
        val entry = Row("s:1", timeline = Row.Info(), children = listOf(Row("tana:text:a")))
        val about = Row("s:2", timeline = Row.Info(uri = "tana:text:a"))
        val other = Row("s:3", timeline = Row.Info(uri = "tana:text:b"))
        assertEquals(listOf(other), engine.shown(listOf(entry, about, other)))
    }

    @Test fun signingOutForgetsTheSessionAndStartsOver() = runTest {
        val host = page()
        val engine = ready(host)
        engine.signOut()
        assertEquals(1, host.cookiesForgotten)
        assertTrue(engine.rows.isEmpty())
        assertNull(engine.email)
        assertEquals(Engine.SESSION, host.loaded.last())
    }

    @Test fun theDemoChoiceIsKeptOnThisPhone() = runTest {
        val store = MemoryStore()
        val engine = Engine(null, FakePlatform(store), backgroundScope, sample = "[]" to "{}")
        engine.demo = true
        assertEquals("true", store.get("demoMode"))
        assertTrue(Engine(null, FakePlatform(store), backgroundScope, sample = "[]" to "{}").demo)
    }

    @Test fun whereNamesHostAndPath() {
        assertEquals("home.tana.inc" to "/api/auth/session", Engine.where("https://home.tana.inc/api/auth/session?x=1"))
        assertEquals("none" to "", Engine.where(null))
    }
}
