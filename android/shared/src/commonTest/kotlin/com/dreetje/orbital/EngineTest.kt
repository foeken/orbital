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
            "orbital.createTask" in body -> text("\"tana:text:new\"")
            "orbital.pin" in body -> throw Exception("Tana refused the pin")
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

    // A page opened here that changed in Tana (ios/engine/live.js 'changed:<id>'): counted for its screen (NodeScreen reads
    // it again), and the Timeline is not read for it
    @Test fun aPageChangedInTanaIsToldToItsScreen() = runTest {
        val host = page()
        val engine = ready(host)
        val reads = host.calls.count { "orbital.timeline" in it.first }
        host.listener!!.said("changed:tana:text:a")
        host.listener!!.said("changed:tana:text:a")
        runCurrent()
        assertEquals(2, engine.changes["tana:text:a"])
        assertNull(engine.changes["tana:text:b"])
        assertEquals(reads, host.calls.count { "orbital.timeline" in it.first }, "a page's change is that page's to read")
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

    // What ChatGPT is asked with and the models' names come from the engine (orbital.prompts, main/prompts.js): read after
    // a Timeline read and again when Auto-translate changes; Process image reads the image with its words
    @Test fun chatGPTsWordsAndTheModelsNamesComeFromTheEngine() = runTest {
        val asked = mutableListOf<String>()
        val platform = FakePlatform(chatgpt = object : ChatGPT by FakeChatGPT(signedIn = true) {
            override suspend fun respond(instructions: String, content: List<kotlinx.serialization.json.JsonObject>, model: String, effort: String, schema: kotlinx.serialization.json.JsonObject?): String? {
                asked += instructions; return "{\"kind\":\"task\",\"title\":\"Call Priya\"}"
            }
        })
        val host = page()
        val base = host.answer
        host.answer = { body, args ->
            when {
                "orbital.prompts" in body -> text("""{"translate":${if (args["to"] == null) "null" else "{\"instructions\":\"into ${args["to"]}\",\"schema\":{}}"},"image":{"instructions":"read it in ${args["to"]}"},"models":{"gpt-6-sol":"Sol 6"},"efforts":{"xhigh":"Extra high"}}""")
                "orbital.fromImage" in body -> text("\"tana:text:img\"")
                else -> base(body, args)
            }
        }
        val engine = ready(host, platform)
        assertEquals("Sol 6", engine.translator.label("gpt-6-sol"))
        assertEquals("gpt-5.5", engine.translator.label("gpt-5.5"), "a model the engine did not name goes by its id")
        assertEquals("Extra high", engine.translator.effortLabel("xhigh"))
        assertNull(engine.translator.prompts!!.translate, "Auto-translate off: nothing to translate with")
        engine.translate("Dutch")
        assertEquals("into Dutch", engine.translator.prompts!!.translate!!.instructions)
        engine.processImage(byteArrayOf(1))
        assertEquals("read it in Dutch", asked.last())
    }

    // Android ended the app with an add, an image and a request on their way: the next launch offers each again, to the
    // account they were for and no other (Engine.fly)
    @Test fun whatWasOnItsWayWhenOrbitalClosedIsOfferedAgainForItsAccount() = runTest {
        val platform = FakePlatform(chatgpt = object : ChatGPT by FakeChatGPT(signedIn = true) {
            override suspend fun respond(instructions: String, content: List<kotlinx.serialization.json.JsonObject>, model: String, effort: String, schema: kotlinx.serialization.json.JsonObject?): String? = awaitCancellation()
        })
        val first = page()
        val answers = first.answer
        first.answer = { body, args ->
            when {
                "orbital.createTask" in body || "orbital.handTo" in body -> awaitCancellation()
                "orbital.prompts" in body -> text("""{"image":{"instructions":"read it"}}""") // the image is read, and its answer never comes
                else -> answers(body, args)
            }
        }
        val engine = ready(first, platform)
        engine.add(Engine.Draft("Book the venue", null, null, null, emptyMap()))
        engine.handOff(Engine.Handing("tana:text:a", Agent("dot", "Dot"), {}), "Look at this")
        engine.addImage { byteArrayOf(1, 2, 3) }
        runCurrent()
        // someone else signs in on this phone first: nothing of it for them, and it stays for its own account
        val elsewhere = page()
        val theirs = elsewhere.answer
        elsewhere.answer = { body, args -> if ("orbital.account()" in body) text("tana:user-profile:else@org_2") else theirs(body, args) }
        val other = ready(elsewhere, platform)
        assertTrue(other.unsent.isEmpty() && other.unhanded.isEmpty() && other.shared == null)
        val again = ready(page(), platform)
        assertEquals("Book the venue", again.unsent.single().title)
        assertTrue(again.unsent.single().why!!.startsWith("Orbital closed before Tana said it was added"))
        assertEquals("Look at this", again.unhanded["tana:text:a"])
        assertTrue(again.shared!!.image!!.contentEquals(byteArrayOf(1, 2, 3)))
        assertNull(platform.files.get(Engine.PENDING), "offered once")
    }

    // what Tana answered is let go of: an add that landed is not offered again
    @Test fun anAddTanaAnsweredIsNotKept() = runTest {
        val platform = FakePlatform()
        val engine = ready(page(), platform)
        engine.add(Engine.Draft("Book the venue", null, null, null, emptyMap()))
        runCurrent()
        assertNull(platform.files.get(Engine.PENDING))
        assertTrue(ready(page(), platform).unsent.isEmpty())
    }

    // a zoomed node's Pin to Today (and the long press's): pinned on screen at once, and back as it was if Tana says no
    @Test fun aPinShowsAtOnceAndGoesBackWhenTanaRefusesIt() = runTest {
        val answer = CompletableDeferred<JsonElement>()
        val host = page()
        val base = host.answer
        host.answer = { body, args -> if ("orbital.pin" in body) answer.await() else base(body, args) }
        val engine = ready(host)
        launch { engine.pin("tana:text:a", true) }
        runCurrent()
        assertTrue("tana:text:a" in engine.pinned)
        answer.completeExceptionally(Exception("Tana refused the pin"))
        runCurrent()
        assertFalse("tana:text:a" in engine.pinned)
        assertEquals("Tana refused the pin", engine.error)
    }

    // the launcher's tasks (Engine.keepTasks): read after a Timeline read at most once in five minutes, a sensitive one
    // without its words, and gone with the account
    @Test fun theTasksGoToTheLauncherAtMostOnceInFiveMinutesAndGoWithTheAccount() = runTest {
        val platform = FakePlatform()
        var reads = 0
        val host = page()
        val base = host.answer
        host.answer = { body, args ->
            if ("orbital.tasks()" in body) { reads++; text("""[{"id":"tana:text:t1","title":"Book the venue","stateType":"open"},{"id":"tana:text:t2","title":"Salary review","stateType":"open","sensitive":true}]""") }
            else base(body, args)
        }
        val engine = ready(host, platform)
        assertEquals(1, reads)
        assertEquals(listOf("Book the venue", ""), platform.tasks.last()!!.map { it.words })
        engine.refresh()
        assertEquals(1, reads, "not again within five minutes")
        clock += 301.seconds
        engine.refresh()
        assertEquals(2, reads)
        engine.signOut()
        assertNull(platform.tasks.last())
    }

    // Move to Inbox, then the read its write sets off while Tana's graph still says open: the Inbox stays until Tana agrees
    @Test fun aTaskMovedToTheInboxStaysThereThroughTheNextRead() = runTest {
        val engine = ready(page(toggle = { "\"proposed\"" }))
        val task = engine.rows.single().children!!.single()
        engine.moveToInbox(task.id)
        clock += 2.seconds
        engine.refresh()
        assertEquals("proposed", engine.state(task))
    }

    // A task's Status set on its own page, the task on no Timeline row: its page's read of it (orbital.access) settles the
    // tick, so a change made elsewhere later shows there too
    @Test fun aStatusSetOnItsPageGoesBackToTanaOnceItsPageReadsIt() = runTest {
        var state = "open"
        val host = page()
        val timelinePage = host.answer
        host.answer = { body, args -> if ("orbital.access" in body) text("""{"title":"Off the Timeline","me":"$ME","task":true,"audience":"only-me","state":"$state"}""") else timelinePage(body, args) }
        val engine = ready(host)
        engine.tick("tana:text:off", "closed")
        assertEquals("closed", engine.states["tana:text:off"])
        state = "closed" // Tana agrees: the page reads Tana from now on
        engine.access("tana:text:off")
        assertNull(engine.states["tana:text:off"])
        // set again, then changed back on the Mac: half a minute on, the page shows the Mac's
        engine.tick("tana:text:off", "not_now")
        state = "open"
        clock += 30.seconds
        assertEquals("open", engine.access("tana:text:off")?.state)
        assertNull(engine.states["tana:text:off"])
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

    // Your Dot (ios/engine/agents.js): the linked agents and the nodes they have come with the setup, only those on offered;
    // a node handed over goes as arguments, never as code, and is kept as its; one the agent did not take says why and is
    // not kept; Unassign lets it go
    @Test fun aNodeHandedToYourDot() = runTest {
        var refuse = false
        val host = page(setup = { text("""{"sensitive":[],"pinned":[],"agents":[{"id":"relay:a1","name":"Echo","app":"ChatGPT","on":true,"isDefault":true},{"id":"relay:a2","name":"Off one","on":false}],"handed":{}}""") })
        val answer = host.answer
        host.answer = { body, args ->
            when {
                "orbital.handTo" in body -> if (refuse) throw Exception("Echo is not listening yet") else text("""{"id":"relay:a1","name":"Echo","status":"assigned"}""")
                "orbital.unhand" in body -> text("true")
                "orbital.setDefault" in body -> text("""[{"id":"relay:a1","name":"Echo","on":true,"isDefault":false},{"id":"relay:a2","name":"Off one","on":true,"isDefault":true}]""")
                "orbital.unlink" in body -> text("""[{"id":"relay:a2","name":"Off one","on":true,"isDefault":true}]""")
                else -> answer(body, args)
            }
        }
        val engine = ready(host)
        assertEquals(listOf("Echo"), engine.agentsOn.map { it.name })
        val echo = engine.agentsOn.single()
        refuse = true
        assertEquals("Echo is not listening yet", runCatching { engine.hand("tana:text:a", echo, "Book the venue") }.exceptionOrNull()?.message)
        assertNull(engine.handed["tana:text:a"])
        refuse = false
        engine.hand("tana:text:a", echo, "Book the venue")
        assertEquals(mapOf("id" to "tana:text:a", "agent" to "relay:a1", "request" to "Book the venue", "demo" to false), host.calls.last { "orbital.handTo" in it.first }.second)
        assertEquals("relay:a1", engine.handed["tana:text:a"])
        engine.unhand("tana:text:a")
        assertNull(engine.handed["tana:text:a"])
        // Settings' swipes: Make Default reads back the agents as the engine left them; Unlink takes the agent's nodes too
        engine.makeDefault(engine.agents.last())
        assertEquals(listOf("Off one", "Echo"), engine.agentsOn.map { it.name }, "the default first in Assign to")
        engine.hand("tana:text:a", echo, "Book the venue")
        engine.unlink(echo)
        assertEquals(mapOf("agent" to "relay:a1", "demo" to false), host.calls.last { "orbital.unlink" in it.first }.second)
        assertEquals(listOf("Off one"), engine.agents.map { it.name })
        assertNull(engine.handed["tana:text:a"], "an unlinked agent keeps no node")
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

    // Quick Add's Pin to today: a task made but not pinned is not made again, and says so after the read that follows it,
    // which clears what was said before it
    @Test fun aTaskMadeButNotPinnedSaysSoAfterTheRead() = runTest {
        val host = page()
        val engine = ready(host)
        assertEquals("tana:text:new", engine.createTask("Book the train", null, today = true))
        assertTrue(host.calls.count { "orbital.timeline" in it.first } >= 2, "the read after the task was made")
        assertEquals("“Book the train” was added, but not pinned to today: Tana refused the pin", engine.error)
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
        engine.unsent.add(Engine.Draft("Not taken", null, null, null, emptyMap()))
        engine.unhanded["tana:text:a"] = "Look at this"
        engine.signOut()
        assertEquals(1, host.cookiesForgotten)
        assertTrue(engine.rows.isEmpty())
        assertNull(engine.email)
        assertTrue(engine.unsent.isEmpty() && engine.unhanded.isEmpty(), "nothing of this account's is offered to the next")
        assertTrue(engine.sensitiveIds.isEmpty())
        assertNull(SavedTimeline.load(platform.files, clock), "the saved Timeline goes with the session")
        assertNull(platform.glimpses.last(), "and the widgets' copy with it")
        assertEquals(Engine.SESSION, host.loaded.last())
    }

    // The Timeline is kept twice, both by keepTimeline: the read for the next launch, and what is on screen for the widgets
    @Test fun aReadKeepsBothCopiesAndATickOnlyTheWidgets() = runTest {
        val platform = FakePlatform()
        var answer = "\"closed\"" // what Tana answers a change of state with
        val engine = ready(page(toggle = { answer }), platform)
        assertEquals(listOf("s:e1"), SavedTimeline.load(platform.files, clock)!!.second.map { it.id }, "the read, for the next launch")
        assertEquals(listOf("s:e1"), platform.glimpses.last()!!.rows.map { it.id }, "and for the widgets")
        val task = engine.rows.single().children!!.single()
        engine.toggle(task)
        assertEquals("closed", platform.glimpses.last()!!.rows.single().children!!.single().stateType, "a tick here is on the widgets at once")
        assertEquals("open", SavedTimeline.load(platform.files, clock)!!.second.single().children!!.single().stateType, "the launch copy stays the read")
        answer = "\"proposed\""
        engine.moveToInbox(task.id)
        assertEquals("proposed", platform.glimpses.last()!!.rows.single().children!!.single().stateType, "and so is Move to Inbox")
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
        assertNull(platform.glimpses.last(), "nor on a widget")
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
        assertEquals(listOf("s:e1"), platform.glimpses.last()!!.rows.map { it.id }, "while the widgets get the masked rows on screen, so nothing real stays on a home screen")
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

    // A request inside Tana's page has no time limit of the WebView's: a page that never said ready, or a first Timeline
    // read that never came back, left the Timeline building itself for good, with nothing to say why (a TestFlight report
    // on the iPhone). Past PATIENCE the app says so (Can't reach Tana, Try again, Details); what comes later still shows.
    @Test fun aPageThatNeverConnectsSaysSoAndStillConnectsLate() = runTest {
        val host = page()
        val engine = launched(host, FakePlatform(), scope = this)
        engine.start()
        advanceTimeBy(Engine.PATIENCE - 1.seconds)
        runCurrent()
        assertEquals(Engine.Phase.Starting, engine.phase, "still connecting within it")
        advanceTimeBy(2.seconds)
        runCurrent()
        assertTrue(engine.phase is Engine.Phase.Failed, "past it, said: " + engine.phase)
        assertTrue(engine.log.any { "did not connect" in it }, "Details names the step")
        host.listener!!.said("ready") // it answers after all
        runCurrent()
        assertEquals(Engine.Phase.Ready, engine.phase)
        assertEquals("s:e1", engine.rows.single().id)
    }

    @Test fun anEarlierStartsDeadlineLeavesTryAgainAlone() = runTest {
        val engine = launched(page(), FakePlatform(), scope = this)
        engine.start()
        advanceTimeBy(Engine.PATIENCE - 5.seconds)
        engine.start() // Try again, just before the first one's time is up
        advanceTimeBy(10.seconds)
        runCurrent()
        assertEquals(Engine.Phase.Starting, engine.phase, "the first start's deadline is not the second's")
        advanceTimeBy(Engine.PATIENCE)
        runCurrent()
        assertTrue(engine.phase is Engine.Phase.Failed)
    }

    @Test fun aFirstReadThatNeverAnswersSaysSoAndShowsWhatComesLate() = runTest {
        val whole = CompletableDeferred<String>()
        val answers = page()
        val host = FakeHost { body, args -> if ("orbital.timeline" in body) text(whole.await()) else answers.answer(body, args) }
        val engine = launched(host, FakePlatform(), scope = this)
        engine.start()
        host.listener!!.said("ready")
        runCurrent()
        assertTrue(engine.loading && engine.rows.isEmpty())
        advanceTimeBy(Engine.PATIENCE + 1.seconds)
        runCurrent()
        assertTrue(engine.phase is Engine.Phase.Failed, "nothing on screen and nothing coming: said: " + engine.phase)
        assertTrue(engine.log.any { "did not send the Timeline" in it })
        whole.complete(timeline) // it comes after all
        runCurrent()
        assertEquals(Engine.Phase.Ready, engine.phase)
        assertEquals("s:e1", engine.rows.single().id)
        assertNull(engine.error)
    }

    // Try again loads the page again: what the page before it answers late is not shown over the new one's
    @Test fun aReadFromThePageBeforeTryAgainIsNotShown() = runTest {
        val whole = CompletableDeferred<String>()
        val answers = page()
        val host = FakeHost { body, args -> if ("orbital.timeline" in body) text(whole.await()) else answers.answer(body, args) }
        val engine = launched(host, FakePlatform(), scope = this)
        engine.start()
        host.listener!!.said("ready")
        runCurrent()
        advanceTimeBy(Engine.PATIENCE + 1.seconds)
        runCurrent()
        engine.start()
        whole.complete(timeline)
        runCurrent()
        assertTrue(engine.rows.isEmpty(), "the old page's read")
        assertEquals(Engine.Phase.Starting, engine.phase)
    }

    // with the saved Timeline on screen there is something to read: a slow read is left to finish
    @Test fun aSlowReadUnderTheSavedTimelineIsLeftToFinish() = runTest {
        val platform = FakePlatform()
        SavedTimeline.save(platform.files, saved, ME, clock)
        val whole = CompletableDeferred<String>()
        val answers = page()
        val host = FakeHost { body, args -> if ("orbital.timeline" in body) text(whole.await()) else answers.answer(body, args) }
        val engine = launched(host, platform, scope = this)
        engine.start()
        host.listener!!.said("ready")
        runCurrent()
        advanceTimeBy(Engine.PATIENCE * 2)
        runCurrent()
        assertEquals(Engine.Phase.Ready, engine.phase)
        assertEquals(listOf("today", "s:old"), engine.rows.map { it.id })
        whole.complete(timeline)
        runCurrent()
        assertEquals(listOf("s:e1"), engine.rows.map { it.id })
    }
}
