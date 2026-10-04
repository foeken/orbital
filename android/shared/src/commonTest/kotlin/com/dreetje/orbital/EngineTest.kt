package com.dreetje.orbital

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
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
import kotlin.time.Duration.Companion.days
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
            "orbital.account()" in body -> text(ME)
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

    // Demo mode turned on and a write at once, before any Timeline read has told the engine: the write itself says
    // so first, and the engine refuses it (ios/engine/index.js)
    @Test fun everyCallSaysWhetherDemoModeIsOn() = runTest {
        val host = page()
        val engine = ready(host)
        engine.demo = true
        engine.markSensitive("tana:text:a", true)
        val write = host.calls.last { "orbital.sensitive" in it.first }
        assertTrue(write.first.startsWith("orbital.demo(demo); "))
        assertEquals(true, write.second["demo"])
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
        val platform = FakePlatform()
        val engine = ready(host, platform)
        assertTrue(SavedTimeline.load(platform.files, clock) != null)
        engine.signOut()
        assertEquals(1, host.cookiesForgotten)
        assertTrue(engine.rows.isEmpty())
        assertNull(engine.email)
        assertNull(SavedTimeline.load(platform.files, clock), "the saved Timeline goes with the session")
        assertEquals(Engine.SESSION, host.loaded.last())
    }

    private val ME = "tana:user-profile:me@org_1" // orbital.account: who, in which workspace

    // The last Timeline read (SavedTimeline): Today's Tasks above a day of entries, as the engine answered them
    private val saved = """[{"id":"today","timeline":{"today":true},"children":[]},{"id":"free","timeline":{"free":{"from":0,"until":1}}},
        {"id":"s:old","segments":[{"text":"Priya completed the plan"}],"timeline":{"tone":"done","day":"2026-10-02"}}]"""

    private fun launched(host: FakeHost, platform: FakePlatform, demoMode: Boolean? = null, scope: TestScope) =
        Engine(host, platform, scope.backgroundScope, demoMode = demoMode, now = { clock })

    @Test fun theLastTimelineIsThereAtLaunchUntilTheReadLands() = runTest {
        val platform = FakePlatform()
        SavedTimeline.save(platform.files, saved, ME, clock)
        val host = page()
        val engine = launched(host, platform, scope = this)
        assertEquals(listOf("today", "s:old"), engine.rows.map { it.id }, "drawn before Tana answers, without a free time that has ended")
        engine.start()
        host.listener!!.said("ready")
        runCurrent()
        assertEquals(listOf("s:e1"), engine.rows.map { it.id })
        assertEquals(listOf("s:e1"), SavedTimeline.load(platform.files, clock)!!.second.map { it.id }, "the read is what the next launch shows")
    }

    @Test fun aDayGoneByKeepsOnlyWhatHappened() = runTest {
        val platform = FakePlatform()
        SavedTimeline.save(platform.files, saved, ME, clock - 1.days)
        assertEquals(listOf("s:old"), SavedTimeline.load(platform.files, clock)!!.second.map { it.id })
    }

    @Test fun anotherWorkspacesTimelineGoesOnceTanaSaysWhoIsSignedIn() = runTest {
        val platform = FakePlatform()
        SavedTimeline.save(platform.files, saved, "tana:user-profile:me@org_2", clock) // you, in another workspace
        val answers = page()
        val host = FakeHost { body, args -> if ("orbital.timeline" in body) throw Exception("slow") else answers.answer(body, args) }
        val engine = launched(host, platform, scope = this)
        engine.start()
        host.listener!!.said("ready")
        runCurrent()
        assertTrue(engine.rows.isEmpty())
        assertNull(SavedTimeline.load(platform.files, clock), "and off the phone: a read that never lands leaves nothing of it for the next launch")
    }

    @Test fun demoModeNeitherShowsNorKeepsTheTimeline() = runTest {
        val platform = FakePlatform()
        SavedTimeline.save(platform.files, saved, ME, clock)
        val host = page()
        val engine = launched(host, platform, demoMode = true, scope = this)
        assertTrue(engine.rows.isEmpty())
        engine.start()
        host.listener!!.said("ready")
        runCurrent()
        assertEquals(listOf("today", "s:old"), SavedTimeline.load(platform.files, clock)!!.second.map { it.id }, "a masked read is not kept")
    }

    @Test fun theFirstPartShowsAheadOfThePage() = runTest {
        val platform = FakePlatform()
        SavedTimeline.save(platform.files, saved, ME, clock)
        val whole = CompletableDeferred<String>()
        val answers = page()
        val host = FakeHost { body, args -> if ("orbital.timeline" in body) text(whole.await()) else answers.answer(body, args) }
        val engine = launched(host, platform, scope = this)
        engine.start()
        host.listener!!.said("ready")
        runCurrent()
        host.listener!!.said("""part:[{"id":"today","timeline":{"today":true},"children":[{"id":"tana:text:n","title":"New today"}]}]""")
        assertEquals(listOf("today", "s:old"), engine.rows.map { it.id }, "the part in place of Today's Tasks, the days under it kept")
        assertEquals("tana:text:n", engine.rows.first().children!!.single().id)
        whole.complete(timeline)
        runCurrent()
        assertEquals(listOf("s:e1"), engine.rows.map { it.id })
        host.listener!!.said("""part:[{"id":"today","timeline":{"today":true}}]""")
        assertEquals(listOf("s:e1"), engine.rows.map { it.id }, "a part told after the page is older than it")
    }

    @Test fun tanaOutOfReachKeepsTheSavedTimelineAndTriesAgain() = runTest {
        val platform = FakePlatform()
        SavedTimeline.save(platform.files, saved, ME, clock)
        val host = page()
        val engine = launched(host, platform, scope = this)
        engine.start()
        host.listener!!.failed("net::ERR_INTERNET_DISCONNECTED")
        assertEquals(listOf("today", "s:old"), engine.rows.map { it.id })
        assertEquals("net::ERR_INTERNET_DISCONNECTED", engine.error)
        engine.refresh() // pulled, or the app came back
        assertEquals(Engine.Phase.Starting, engine.phase)
        assertEquals(listOf(Engine.SESSION, Engine.SESSION), host.loaded)
    }

    @Test fun aWriteBeforeTanaConnectsWaitsForIt() = runTest {
        val platform = FakePlatform()
        SavedTimeline.save(platform.files, saved, ME, clock)
        val host = page()
        val engine = launched(host, platform, scope = this)
        engine.start()
        launch { engine.markSensitive("tana:text:a", true) }
        advanceTimeBy(500)
        assertTrue(host.calls.none { "orbital.sensitive" in it.first }, "nothing asked of a page that is not there yet")
        host.listener!!.said("ready")
        runCurrent()
        advanceTimeBy(200)
        runCurrent()
        assertTrue(host.calls.any { "orbital.sensitive" in it.first })
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

    @Test fun demoModeTurnedOnTakesTheRealRowsAwayAtOnce() = runTest {
        val platform = FakePlatform()
        SavedTimeline.save(platform.files, saved, ME, clock)
        val host = page()
        val engine = launched(host, platform, scope = this)
        engine.start()
        host.listener!!.failed("net::ERR_INTERNET_DISCONNECTED")
        engine.demo = true
        assertTrue(engine.rows.isEmpty(), "no real words on screen in demo mode, Tana out of reach or not")
    }

    // the session ran out and someone else signed in: what was on screen was the last account's
    @Test fun signingInAgainAsSomeoneElseTakesTheirRowsAway() = runTest {
        var who = ME
        var slow = false
        val answers = page()
        val host = FakeHost { body, args ->
            when {
                "orbital.account()" in body -> text(who)
                "orbital.timeline" in body && slow -> throw Exception("slow")
                else -> answers.answer(body, args)
            }
        }
        val platform = FakePlatform()
        val engine = ready(host, platform)
        assertEquals(listOf("s:e1"), engine.rows.map { it.id })
        who = "tana:user-profile:someone@org_1"
        slow = true
        host.listener!!.said("ready") // the page again, after Tana's sign-in
        runCurrent()
        assertTrue(engine.rows.isEmpty(), "the other account's rows are gone before the new read lands")
        assertNull(SavedTimeline.load(platform.files, clock))
    }

    @Test fun aTapOnAnotherAccountsSavedTimelineIsNotDone() = runTest {
        val platform = FakePlatform()
        SavedTimeline.save(platform.files, saved, "tana:user-profile:someone@org_1", clock)
        val host = page() // signs in as ME
        val engine = launched(host, platform, scope = this)
        engine.start()
        launch { engine.markSensitive("tana:text:a", true) }
        advanceTimeBy(500)
        host.listener!!.said("ready")
        runCurrent()
        advanceTimeBy(200)
        runCurrent()
        assertTrue(host.calls.none { "orbital.sensitive" in it.first }, "asked of someone else's row: never written to this account")
    }
}
