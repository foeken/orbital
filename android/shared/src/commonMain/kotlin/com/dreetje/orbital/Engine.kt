package com.dreetje.orbital

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlin.io.encoding.Base64
import kotlin.time.Clock
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Instant

// Everything the screens show and do, over the engine (ios/Orbital/Engine.swift, call for call): signing in on Tana's
// own page, the Timeline and its refresh, a node opened, and every write, each drawn at once and put back with the
// reason when Tana refuses it. With no host it runs on the iPhone's invented sample (-sample) and writes nothing.
@Stable
class Engine(
    private val host: EngineHost?,
    val platform: Platform,
    val scope: CoroutineScope,
    sample: Pair<String, String>? = null, // timeline-sample.json and pages-sample.json, for -sample
    history: Boolean = false, // -history: the day's entries only
    demoMode: Boolean? = null, // overrides what this phone kept, for one launch (as -demoMode NO in the iPhone's tests)
    val now: () -> Instant = { Clock.System.now() }, // the clock every screen reads, fixed in tests
) : EngineHost.Listener {
    sealed interface Phase {
        data object Starting : Phase
        data object SignedOut : Phase
        data object Ready : Phase
        data class Failed(val message: String) : Phase
    }

    var phase by mutableStateOf<Phase>(Phase.Starting)
        private set
    var rows by mutableStateOf(listOf<Row>())
        private set
    var loading by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
    var pages by mutableStateOf(1)
        private set
    var email by mutableStateOf<String?>(null) // the Tana account signed in, for Settings
        private set
    val states = mutableStateMapOf<String, String>() // task id -> the stateType ticked here, until a read of Tana agrees with it
    private val ticked = mutableMapOf<String, Instant>() // task id -> when it was ticked here
    // What sign-in and the session did, newest last, for Details: cookie names only, never a value. A line is added only
    // when it differs from the one before.
    val log = mutableStateListOf<String>()
    // its answers kept in a file of their own (Platform.files): one ever-growing string, rewritten on every flush
    val translator = Translator(platform.files, platform.chatgpt, platform::language, scope)
    var sensitiveIds by mutableStateOf(setOf<String>()) // marked sensitive in Orbital (synced), for the long-press menu
        private set
    var pinned by mutableStateOf(setOf<String>()) // pinned to a day, any day, for the long-press menu
        private set
    var agents by mutableStateOf(listOf<Agent>()) // your Dot and any other agent linked through orbital.md (ui/Agents.kt), for the long-press menu
        private set
    var handed by mutableStateOf(mapOf<String, String>()) // node -> the linked agent it is handed to
        private set
    var handing by mutableStateOf<Handing?>(null) // Assign to <its name> …: the node whose request is being written
    var removed by mutableStateOf(setOf<String>()) // deleted here: gone from every list at once, before Tana confirms it
        private set
    val changes = mutableStateMapOf<String, Int>() // page id -> how often it changed in Tana since it was opened (engine.js 'changed:<id>', live.js): NodeScreen reads it again
    var unpinned by mutableStateOf(setOf<String>()) // pins being taken off here, out of Today's Tasks before Tana answers
        private set
    var reveal by mutableStateOf(false) // sensitive items shown, after a shake; never kept
    var assigning by mutableStateOf<Assigning?>(null) // Assign to …: the task whose picker is open
    var asking by mutableStateOf<ShareAsk?>(null) // someone just assigned who cannot open it: Grant access or Keep private
    var shared by mutableStateOf<Shared?>(null) // shared to Orbital from another app: Quick Add opens with it
    var widget by mutableStateOf<String?>(null) // a widget's tap with the app already open: a node's id to open, or "add" for Quick Add

    // Settings' Demo mode, as the desktop's: made-up words and names on screen, nothing saved (ios/engine/demo.js); kept on this phone
    private var demoOn by mutableStateOf(demoMode ?: (platform.store.get("demoMode") == "true"))
    var demo: Boolean
        get() = demoOn
        set(on) {
            demoOn = on
            platform.store.set("demoMode", if (on) "true" else null)
            opened.clear() // a page read before it was turned on or off shows its words as they were then
            partsFor = null // what a read under way brings is the other mode's
            if (on && !isSample) rows = emptyList() // the real words go at once, rather than staying until the masked read lands, or for good with Tana out of reach
            scope.launch { refresh() }
        }

    // people: false on a node that is not a task, whose Assign to lists only your agents
    data class Assigning(val id: String, val current: List<String>?, val then: suspend () -> Unit, val people: Boolean = true)
    data class Handing(val id: String, val agent: Agent, val then: suspend () -> Unit)
    data class ShareAsk(val id: String, val access: Access, val shut: List<Member>, val then: suspend () -> Unit)
    class Shared(val text: String?, val image: ByteArray?) {
        companion object {
            // the words that came with it, each once, a line apiece (ios/Share/ShareViewController.swift): on Android a
            // share's subject (a page's title), then its text (often the link); null when there are none
            fun words(vararg parts: String?): String? =
                parts.mapNotNull { it?.trim()?.takeIf(String::isNotEmpty) }.distinct().joinToString("\n").ifEmpty { null }
        }
    }

    val isSample = host == null
    private val pagesSample: Sample? = sample?.let { json.decodeFromString<Sample>(it.second) }
    private var watch: Job? = null
    private var justSignedIn = false
    private var session = 0 // counts sign-outs: a read that began before one never saves or shows what it got
    private var attempt = 0 // counts the session page's loads (start): a deadline or a read of an earlier one does nothing now
    private var again = false // a change told while a read is under way: one more read follows it
    private var savedFor: String? = null // whose the saved Timeline on screen is, until Tana says who is signed in
    private var account: String? = null // who is signed in, in which workspace (orbital.account): what the saved Timeline is kept for
    private var partsFor: Int? = null // the session whose Timeline read is under way, taking its first part (show)
    // the last read of each node opened, newest last: a page gone back to shows it at once while it is read again, as
    // the iPhone's NavigationStack keeps the page under the one on top (NodeScreen starts from cached(id))
    private val opened = LinkedHashMap<String, Page>()

    init {
        host?.listener = this
        if (sample != null) {
            rows = sampleRows(sample.first, now()).let { all ->
                if (history) all.filter { !it.top } else all
            }
            phase = Phase.Ready
            scope.launch { keepTimeline() } // the widgets draw the sample too
        } else if (host != null && !demoOn) {
            // the last Timeline read, on screen at once while Tana connects (SavedTimeline); never in demo mode
            SavedTimeline.load(platform.files, now())?.let { (whose, saved) -> rows = saved; savedFor = whose }
        }
    }

    fun start() {
        val host = host ?: return
        watch?.cancel()
        phase = Phase.Starting
        val load = ++attempt
        // Tana's page connected within PATIENCE (connect), or the app says so, where it built the Timeline for good: a
        // request inside the page has no time limit of the WebView's. Connected later, it goes on from there.
        scope.launch {
            delay(PATIENCE)
            if (load != attempt || phase != Phase.Starting) return@launch
            note("Tana's page did not connect in ${PATIENCE.inWholeSeconds} s")
            fail("Tana did not answer in ${PATIENCE.inWholeSeconds} seconds.")
        }
        note("loading the session page")
        host.load(SESSION)
    }

    fun note(line: String) {
        if (log.lastOrNull()?.drop(9) == line) return
        log.add(Times.hms(now()) + " " + line)
        if (log.size > 100) log.removeAt(0)
    }

    override fun said(message: String) {
        // engine.js says 'ready' once it is loaded on the session page, 'changed' when the Timeline moved under it,
        // 'changed:<id>' when a page opened here changed (ios/engine/live.js), and 'part:' with the first rows of a
        // Timeline read still under way
        if (message.startsWith("part:")) return show(message.removePrefix("part:"))
        if (message.startsWith("changed:")) { val id = message.removePrefix("changed:"); changes[id] = (changes[id] ?: 0) + 1; return }
        when (message) {
            "changed" -> scope.launch { refresh() }
            "ready" -> scope.launch { connect() }
        }
    }

    // A page that never started: offline, or Tana unreachable, sign-in included, where no page of Tana's is there to say so
    override fun failed(message: String) {
        note("load failed: " + message)
        watch?.cancel()
        fail(message)
    }

    // Tana out of reach, or a session that could not be read: said in place of the app, or under the saved Timeline when
    // one is on screen (OrbitalApp), where pulling it or coming back to the app tries again (refresh)
    private fun fail(message: String) {
        phase = Phase.Failed(message)
        error = message
    }

    // Android stopped Tana's page to free memory and EngineWeb made a new one (onRenderProcessGone; the iPhone's
    // webViewWebContentProcessDidTerminate): started again on it, the rows kept on screen until the new read lands
    override fun restarted(why: String) {
        note(why)
        start()
    }

    private suspend fun connect() {
        val host = host ?: return
        try {
            val ok = host.run("return await orbital.connect()").jsonPrimitive.booleanOrNull == true
            note("engine: session " + (maybe { host.run("return orbital.why()").jsonPrimitive.contentOrNull } ?: "?"))
            when {
                ok -> {
                    justSignedIn = false
                    email = maybe { host.run("return orbital.email()").jsonPrimitive.contentOrNull }
                    val was = savedFor ?: account // whose rows are on screen: the saved Timeline's, or the session's before this one ran out
                    account = maybe { host.run("return orbital.account()").jsonPrimitive.contentOrNull }
                    // another account's, or another workspace's: off the screen and off the phone, with the pages read for it
                    if (was != null && was != account) { rows = emptyList(); opened.clear(); forgetTimeline() }
                    savedFor = null
                    host.keepCookies() // at once: the refresh may not finish
                    phase = Phase.Ready
                    refresh()
                }
                // Tana said signed in a moment ago: say so, rather than showing its sign-in again and again
                justSignedIn -> {
                    justSignedIn = false
                    fail("You signed in to Tana, but Orbital could not read the session. Try again.")
                }
                else -> signIn()
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            note("engine failed: " + e.message)
            fail(e.message ?: "The engine did not start")
        }
    }

    // Tana's own sign-in in the engine's web view; signed in is what Tana's session says, asked every two seconds as the
    // desktop's login window does (tana-session.js login)
    private fun signIn() {
        val host = host ?: return
        watch?.cancel() // a session that ran out mid-refresh comes here with the last watch perhaps still going
        phase = Phase.SignedOut
        note("showing Tana's sign-in")
        host.load(HOME)
        watch = scope.launch {
            while (isActive) {
                delay(2000)
                if (phase != Phase.SignedOut) continue
                val cookies = host.cookieNames().sorted().joinToString(", ")
                val (name, path) = where(host.url)
                if (name != "home.tana.inc") { note("$name · cookies: $cookies"); continue }
                var answer = "no answer"
                try {
                    // a page that never answers (it was replaced under the call) must not stop the asking
                    answer = withTimeoutOrNull(10.seconds) { host.run(PROBE, anyTanaPage = true) }?.jsonPrimitive?.contentOrNull ?: answer
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    answer = e.message ?: answer
                }
                note("$name$path · session $answer · cookies: $cookies")
                if (answer.endsWith(" signed in") && isActive) {
                    justSignedIn = true
                    start()
                    return@launch
                }
            }
        }
    }

    suspend fun refresh() {
        if (phase is Phase.Failed && rows.isNotEmpty() && !isSample) { start(); return } // the saved Timeline on screen, Tana out of reach: try again
        if (phase != Phase.Ready || isSample) return
        if (loading) { again = true; return }
        loading = true
        // a read cut off midway (the screen that asked went away) still lets the next one through: with loading left
        // set, every refresh after it only said "again" and the Timeline never moved
        try { read() } finally { loading = false }
        if (again) { again = false; refresh() }
    }

    // Back in front (MainActivity onResume): a sync stream that died while the app was away is made again first
    // (orbital.resume), so the read that follows is not answered short, Today's Tasks empty, by a dead one
    suspend fun foreground() {
        val host = host
        if (phase == Phase.Ready && !isSample && host != null) maybe { host.run("return await orbital.resume()") }
        refresh()
    }

    private suspend fun read() {
        val host = host ?: return
        val started = session
        val masked = demo
        val load = attempt
        partsFor = session
        // nothing on screen: the Timeline builds itself for PATIENCE at most, then the app says so (Try again loads the
        // page again); with rows on screen, or a first part of them, there is something to read while it finishes
        val deadline = scope.launch {
            delay(PATIENCE)
            if (load != attempt || phase != Phase.Ready || rows.isNotEmpty()) return@launch
            note("Tana's page did not send the Timeline in ${PATIENCE.inWholeSeconds} s")
            fail("Tana has not sent your Timeline in ${PATIENCE.inWholeSeconds} seconds. It may still come.")
        }
        try {
            var raw = ""
            val read: List<Row> = reply("return await orbital.timeline(pages)", mapOf("pages" to pages)) { raw = it; json.decodeFromString(it) }
            partsFor = null // a part told late is older than this
            // signed out meanwhile, demo mode switched (the read it asked for shows), or the page loaded again since
            if (started != session || masked != demo || load != attempt) return
            if (phase is Phase.Failed) phase = Phase.Ready // it answered after all
            rows = read
            error = null
            settle(rows)
            maybe { call<Setup>("return await orbital.setup()") }?.let { setup ->
                translator.use(setup.to, setup.ai)
                if (translator.catalogue.isEmpty()) maybe { platform.chatgpt.models() }?.takeIf { it.isNotEmpty() }?.let { translator.catalogue = it } // once: what this account may ask
                sensitiveIds = setup.sensitive.toSet()
                pinned = setup.pinned.toSet()
                setup.agents?.let { agents = it }
                setup.handed?.let { handed = it }
            }
            keepTimeline(raw)
            maybe { host.run("return orbital.issues()").jsonArray.map { it.jsonPrimitive.content } }?.forEach(::note)
            host.keepCookies() // Tana rotates the session: keep the newest
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (started != session || load != attempt) return
            if (e.message?.contains("not authenticated") == true) signIn() // the session ran out: sign in again
            error = e.message
        } finally {
            deadline.cancel()
            partsFor = null
        }
    }

    // The Timeline's first part, Today's Tasks and Upcoming meetings, told while the rest is still read (ios/engine/read.js):
    // it takes the place of the same rows on screen, and the days under them stay until the whole page lands. The last part
    // can be the whole page.
    private fun show(part: String) {
        if (partsFor != session) return
        val got = runCatching { json.decodeFromString<List<Row>>(part) }.getOrNull() ?: return
        rows = if (got.all { it.top }) got + rows.filter { !it.top } else got
    }

    suspend fun more() {
        if (loading || phase != Phase.Ready) return // a second tap while the first is loading would count a page never read
        pages += 1
        refresh()
    }

    // Settings' Log out: the engine lets its session lookups finish and closes, then Tana's cookies go, and the page
    // starts over at Tana's sign-in. A refresh still under way sees the count move and keeps nothing.
    suspend fun signOut() {
        val host = host ?: return
        session += 1
        maybe { host.run("await orbital.signOut()") }
        host.forgetCookies()
        forgetTimeline()
        rows = emptyList(); states.clear(); removed = emptySet(); email = null; account = null; pages = 1; opened.clear()
        note("signed out")
        start()
    }

    // Your saved searches, those pinned to your sidebar first (orbital.searches)
    suspend fun searches(): List<Row> = pagesSample?.searches ?: call("return await orbital.searches()")

    suspend fun open(id: String): Page {
        pagesSample?.let { return it.pages[id] ?: throw Failure("Not in the sample") }
        val started = session
        val page: Page = call("return await orbital.open(id)", mapOf("id" to id))
        settle(page.rows) // a search's tasks ticked here, once Tana agrees
        if (started == session) {
            opened.remove(id)
            opened[id] = page
            if (opened.size > 30) opened.remove(opened.keys.first())
        }
        return page
    }

    // what open(id) last read, to draw until it reads again; null when never opened (or since signing out)
    fun cached(id: String): Page? = pagesSample?.pages?.get(id) ?: opened[id]

    // The Timeline is kept on this phone twice, both written here and nowhere else (Engine.swift keepTimeline the same):
    //   - SavedTimeline, for the next launch to draw while Tana connects: the first page as engine.js answered it, a
    //     sensitive row's words included (drawn blurred), tied to the account it is for, in Platform.files.
    //   - the widgets' Glimpse (Platform.keepGlimpse; androidApp Widgets.kt): the rows on screen, a box ticked here ticked
    //     and what was deleted or unpinned here gone, each sensitive one without its words (nobody shakes a widget).
    // raw: the Timeline as engine.js answered it, after a read; null after a change made here, which only the widgets show
    // before the next read. In demo mode the widgets get the masked rows on screen, so nothing real shows on a home screen
    // either, and the launch copy is left as it was: masked words are no launch's to show. Both go together
    // (forgetTimeline): signed out, or another account signed in.
    suspend fun keepTimeline(raw: String? = null) {
        if (raw != null && !demo && pages == 1) account?.let { SavedTimeline.save(platform.files, raw, it, now()) }
        platform.keepGlimpse(glimpse())
    }

    suspend fun forgetTimeline() {
        SavedTimeline.forget(platform.files)
        platform.keepGlimpse(null) // nothing of the account left on a widget
    }

    fun glimpse(): Glimpse {
        fun keep(list: List<Row>?): List<Row>? = list?.let(::shown)?.map { r ->
            val words = if (r.sensitive == true) r.copy(text = null, title = null, segments = null, subtext = null, people = null, reference = r.reference?.copy(label = null),
                timeline = r.timeline?.copy(note = null, change = null, detail = null)) else r
            // a tick made here: on the task, and on an Activity line about it (its uri), which the widget draws as the task
            words.copy(stateType = states[r.id] ?: r.timeline?.uri?.let { states[it] } ?: r.stateType,
                children = keep(if (r.timeline?.today == true) r.children?.filter { it.id !in unpinned } else r.children))
        }
        return Glimpse(now().toEpochMilliseconds(), keep(rows)!!)
    }

    // Long press: Pin to Today and Mark as Sensitive, then the Timeline read again. Remove Pin takes the task out of
    // Today's Tasks at once; the read after says where it is now.
    suspend fun pin(id: String, on: Boolean) {
        if (!on) unpinned = unpinned + id
        act("return await orbital.pin(id, on)", mapOf("id" to id, "on" to on))
        unpinned = unpinned - id
    }

    // Settings' Auto-translate: the synced preference (orbital.translateTo), shown at once and kept if Tana takes it
    suspend fun translate(to: String?) {
        val was = translator.to
        translator.use(to)
        if (isSample) return
        try { call<String?>("return await orbital.translateTo(to)", mapOf("to" to to)) } catch (e: Failure) { translator.use(was); error = e.message }
    }

    // Settings' Quick and Regular AI: used at once, kept if Tana takes it (orbital.aiChoice)
    suspend fun aiChoice(key: String, value: String) {
        val was = translator.ai
        translator.use(translator.to, mapOf(key to value))
        if (isSample) return
        try { call<Boolean>("return await orbital.aiChoice(key, value)", mapOf("key" to key, "value" to value)) } catch (e: Failure) { translator.use(translator.to, was); error = e.message }
    }

    suspend fun markSensitive(id: String, on: Boolean) = act("return await orbital.sensitive(id, on)", mapOf("id" to id, "on" to on))

    suspend fun members(): List<Member> = if (isSample) emptyList() else maybe { call<List<Member>>("return await orbital.members()") } ?: emptyList()

    // Someone just assigned who cannot open the task: asked there and then, Grant access or Keep private
    suspend fun assign(id: String, uri: String?, then: suspend () -> Unit = {}) {
        if (isSample) return
        try {
            val shut: List<String> = call("return await orbital.assign(id, uris)", mapOf("id" to id, "uris" to listOfNotNull(uri)))
            if (shut.isNotEmpty()) access(id)?.let { a -> asking = ShareAsk(id, a, a.hidden.filter { it.id in shut }, then) }
            refresh()
        } catch (e: Failure) { error = e.message }
    }

    suspend fun access(id: String): Access? = if (isSample) null else maybe { call<Access>("return await orbital.access(id)", mapOf("id" to id)) }

    // Your Dot (ios/engine/agents.js, ui/Agents.kt): the agents linked through orbital.md, linking one with a code as the
    // Mac's Connect to your OpenAI Dot does, and a node handed to one with a request (Assign to <its name> …) or taken back
    val agentsOn: List<Agent> get() = agents.filter { it.on }.sortedBy { !it.isDefault } // what Assign to <its name> … offers, the default first
    // the relay asked again (Settings, the Connect page): why not, when it could not be reached and the last list is shown
    suspend fun loadAgents(): String? {
        if (isSample) return null
        return try {
            val list: AgentList = call("return await orbital.agents()")
            agents = list.agents; handed = list.handed
            list.problem
        } catch (e: Failure) { e.message }
    }
    suspend fun linkCode(): LinkCode = if (isSample) throw Failure("The sample saves nothing") else call("return await orbital.linkCode()")
    suspend fun linkStatus(code: String): LinkState = call("return await orbital.linkStatus(code)", mapOf("code" to code))
    suspend fun linkCancel(code: String) { maybe { call<Boolean>("return await orbital.linkCancel(code)", mapOf("code" to code)) } } // gone anyway in fifteen minutes
    // throws, so the sheet stays open with what went wrong (not listening yet, did not take it, read-only)
    suspend fun hand(id: String, agent: Agent, request: String) {
        if (isSample) throw Failure("The sample saves nothing")
        call<HandedTo?>("return await orbital.handTo(id, agent, request)", mapOf("id" to id, "agent" to agent.id, "request" to request))
        handed = handed + (id to agent.id)
    }
    suspend fun unhand(id: String) {
        if (isSample) return
        try { call<Boolean>("return await orbital.unhand(id)", mapOf("id" to id)); handed = handed - id } catch (e: Failure) { error = e.message }
    }
    // Settings' swipes on an agent: Make Default, and Unlink, which also unassigns its nodes (orbital.setDefault, orbital.unlink)
    suspend fun makeDefault(agent: Agent) {
        if (isSample) return
        try { agents = call("return await orbital.setDefault(agent)", mapOf("agent" to agent.id)) } catch (e: Failure) { error = e.message }
    }
    suspend fun unlink(agent: Agent) {
        if (isSample) return
        try {
            agents = call("return await orbital.unlink(agent)", mapOf("agent" to agent.id))
            handed = handed.filterValues { it != agent.id }
        } catch (e: Failure) { error = e.message }
    }

    suspend fun share(id: String, rule: String, uris: List<String> = emptyList(), token: String? = null) =
        act("return await orbital.share(id, rule, uris, token)", mapOf("id" to id, "rule" to rule, "uris" to uris, "token" to token))

    private suspend fun act(body: String, args: Map<String, Any?>) {
        if (isSample) return
        try { call<Boolean>(body, args); refresh() } catch (e: Failure) { error = e.message }
    }

    // Quick Add Task: the types to pick from, a type's fields, what a person or link field can take, a saved search's preset
    suspend fun typeFields(type: String): List<Field> = if (isSample) emptyList() else maybe { call<List<Field>>("return await orbital.typeFields(type)", mapOf("type" to type)) } ?: emptyList()
    suspend fun fieldChoices(key: String, query: String): List<Member> = if (isSample) emptyList() else maybe { call<List<Member>>("return await orbital.fieldChoices(key, query)", mapOf("key" to key, "query" to query)) } ?: emptyList()
    suspend fun searchPreset(id: String): Preset? = if (isSample) null else maybe { call<Preset?>("return await orbital.searchPreset(id)", mapOf("id" to id)) }
    suspend fun taskTypes(): List<TaskType> = if (isSample) emptyList() else maybe { call<List<TaskType>>("return await orbital.taskTypes()") } ?: emptyList()

    // today: Quick Add's Pin to today, the made task pinned as a long press pins one; a task made but not pinned is not
    // made again, it says so
    suspend fun createTask(title: String, type: String?, search: String? = null, assignee: String? = null, values: Map<String, Value> = emptyMap(), today: Boolean = false): String {
        if (isSample) throw Failure("The sample saves nothing")
        val id: String = call("return await orbital.createTask(title, type, search, assignee, values)",
            mapOf("title" to title, "type" to type, "search" to search, "assignee" to assignee, "values" to values.mapValues { it.value.asJson() }))
        var notPinned: String? = null // said after the refresh below, which clears what was said before it
        if (today) try { call<Boolean>("return await orbital.pin(id, on)", mapOf("id" to id, "on" to true)) } catch (e: Failure) {
            notPinned = "“$title” was added, but not pinned to today: ${e.message}"
        }
        // a new task is yours alone: given to someone else, they are asked about as Assign to asks
        if (assignee != null) access(id)?.takeIf { it.hidden.isNotEmpty() }?.let { asking = ShareAsk(id, it, it.hidden) {} }
        refresh()
        notPinned?.let { error = it }
        return id
    }

    // The image, already a JPEG of 2048 px at most, read by ChatGPT, then made into its node (orbital.fromImage)
    suspend fun processImage(jpeg: ByteArray): String {
        if (isSample) throw Failure("The sample saves nothing")
        val read = ChatGPT.readImage(platform.chatgpt, jpeg, translator.to, translator.ai.getValue("model"), translator.ai.getValue("effort"))
        val id: String = call("return await orbital.fromImage(kind, title, notes, image, 'image/jpeg')",
            mapOf("kind" to (read.kind ?: "doc"), "title" to (read.title ?: ""), "notes" to (read.notes ?: emptyList()), "image" to Base64.encode(jpeg)))
        refresh()
        return id
    }

    // Quick Add closes the moment you press Add: what it asked for is made here while you go on, and the + in the bar turns
    // while anything is on its way (Shell), so another can be added meanwhile. A task Tana did not take is kept as unsent,
    // and the next Quick Add opens with it and says why; an image's node opens once it is made, as the desktop opens it.
    var adding by mutableStateOf(0)
        private set
    val unsent = mutableStateListOf<Draft>()
    var made by mutableStateOf<String?>(null)
    data class Draft(val title: String, val type: String?, val search: String?, val assignee: Member?, val values: Map<String, Value>, val today: Boolean = false, val why: String? = null)
    fun add(draft: Draft) {
        adding++
        scope.launch {
            try { createTask(draft.title, draft.type, draft.search, draft.assignee?.id, draft.values, draft.today) } catch (e: Failure) {
                unsent.add(draft.copy(why = e.message))
                error = "“${draft.title}” was not added: ${e.message}"
            } finally { adding-- }
        }
    }
    // load: the image, read once Quick Add has gone (a photo pick, the clipboard, something shared)
    fun addImage(load: suspend () -> ByteArray?) {
        adding++
        scope.launch {
            try {
                val jpeg = load() ?: throw Failure("The image could not be read")
                // shared while Orbital was not running: Tana connects first; signed out or failed, it says so rather than waiting for ever
                while (phase != Phase.Ready) {
                    if (phase != Phase.Starting) throw Failure("Sign in to Tana first, then share it again")
                    delay(200)
                }
                made = processImage(jpeg)
            } catch (e: Failure) { error = e.message } finally { adding-- }
        }
    }

    // Long press, Delete (orbital.remove): to Tana's trash; the row goes at once and comes back if Tana says no
    suspend fun remove(id: String): Boolean {
        removed = removed + id
        if (isSample) return true
        return try {
            call<String>("return await orbital.remove(id)", mapOf("id" to id))
            refresh()
            true
        } catch (e: Failure) {
            removed = removed - id
            error = e.message
            false
        }
    }

    // a list without what was deleted here: a node, an entry about one, a search result for one, and an entry that is
    // only the tasks it brought once they are all deleted
    fun shown(list: List<Row>?): List<Row> = (list ?: emptyList()).filter { row ->
        val gone = { id: String? -> id != null && id in removed }
        if (gone(row.id) || gone(row.timeline?.uri) || gone(row.target)) return@filter false
        val tasks = row.children
        if (tasks.isNullOrEmpty() || row.timeline == null || row.timeline.uri != null) return@filter true
        !tasks.all { gone(it.id) }
    }

    // Ask Tana: a new chat with what you typed as its first message; a follow-up in a chat
    suspend fun ask(text: String): Sent = if (isSample) Sent("tana:chat:000000000000000000000000c1") else call("return await orbital.ask(text)", mapOf("text" to text))
    suspend fun send(text: String, to: String): Sent = if (isSample) Sent(to) else call("return await orbital.send(id, text)", mapOf("id" to to, "text" to text))

    // A task's box: drawn in its new state at once, written by engine.js (orbital.toggle, the desktop's rule), and put
    // back with the reason if Tana refuses. The row stays where it is; the next read confirms it.
    suspend fun toggle(task: Row) {
        if (demo) return // a box does nothing in demo mode, as the desktop's is disabled
        val before = state(task)
        states[task.id] = if (before == "proposed" || before == "closed") "open" else "closed"
        ticked[task.id] = now()
        try {
            if (isSample) return // the sample writes nothing
            try {
                states[task.id] = call<String>("return await orbital.toggle(id)", mapOf("id" to task.id))
            } catch (e: Failure) {
                states[task.id] = before
                error = e.message
            }
        } finally { keepTimeline() } // the widgets show it ticked too
    }

    // Long press, Move to Inbox: the task back to Tana's Inbox state (proposed)
    suspend fun moveToInbox(id: String) {
        if (demo || isSample) return
        val before = states[id]
        states[id] = "proposed"
        try {
            try {
                states[id] = call<String>("return await orbital.toggle(id, 'proposed')", mapOf("id" to id))
            } catch (e: Failure) {
                if (before == null) states.remove(id) else states[id] = before
                error = e.message
            }
        } finally { keepTimeline() } // the widgets show it in the Inbox too
    }

    fun state(task: Row): String = states[task.id] ?: task.stateType ?: if (task.done == true) "closed" else "open"

    // A widget's box (Widgets.kt; Engine.swift tick): the task set to what the widget showed it becoming, drawn so at once
    // and written as soon as the engine has connected (a cold start waits for it), put back with the reason if Tana
    // refuses. Set outright, so a second tap on a widget not yet drawn again does not undo the first.
    suspend fun tick(id: String, to: String) {
        if (demo) return
        val before = states[id]
        states[id] = to
        ticked[id] = now()
        try {
            if (isSample) return
            try {
                states[id] = call<String>("return await orbital.toggle(id, to)", mapOf("id" to id, "to" to to))
            } catch (e: Failure) {
                if (before == null) states.remove(id) else states[id] = before
                error = e.message
            }
        } finally { keepTimeline() } // the widgets drawn again with it
    }

    // A box ticked here goes back to reading Tana once a read shows it as ticked, or once a read still disagrees half a
    // minute on: the graph can trail a write by seconds, never by that long. One not in the rows read keeps its tick.
    private fun settle(rows: List<Row>) {
        val at = now()
        for ((id, state) in states.toMap()) {
            val read = stateType(id, rows) ?: continue
            if (read == state || at - (ticked[id] ?: Instant.DISTANT_PAST) >= 30.seconds) states.remove(id)
        }
        ticked.keys.retainAll(states.keys)
    }

    private fun stateType(id: String, rows: List<Row>): String? {
        for (row in rows) {
            if (row.id == id) return row.stateType
            stateType(id, row.children ?: emptyList())?.let { return it }
        }
        return null
    }

    private suspend inline fun <reified T> call(body: String, args: Map<String, Any?> = emptyMap()): T =
        reply(body, args) { json.decodeFromString<T>(it) }

    // decode: what to make of the JSON engine.js answers
    private suspend fun <T> reply(body: String, args: Map<String, Any?>, decode: (String) -> T): T {
        val host = host ?: throw Failure("Not in the sample")
        try {
            val owner = account ?: savedFor // whose screen this was asked from
            connected()
            // a tap on a row of another account's, made before Tana said who signed in: not done to this one
            if (owner != null && owner != account) throw Failure("Another Tana account is signed in now, so this was not done")
            // every call says first whether Demo mode is on (ios/engine/demo.js), so the engine refuses a write from the
            // moment it is turned on, not from the next Timeline read, which a read already under way puts off
            val answer = host.run("orbital.demo(demo); " + body, args + ("demo" to demo))
            val text = (answer as? JsonPrimitive)?.takeIf { it.isString }?.content ?: "null"
            return decode(text)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            note((Regex("orbital\\.(\\w+)").find(body)?.groupValues?.get(1) ?: "engine") + " failed: " + e.message)
            throw Failure(e.message ?: "The engine failed")
        }
    }

    // The saved Timeline is on screen before the engine has connected: what is asked of it meanwhile waits for it
    private suspend fun connected() {
        while (phase == Phase.Starting) delay(100)
        (phase as? Phase.Failed)?.let { throw Failure(it.message) }
        if (phase == Phase.SignedOut) throw Failure("Signed out of Tana")
    }

    companion object {
        const val SESSION = "https://home.tana.inc/api/auth/session"
        const val HOME = "https://home.tana.inc"
        // how long Tana's page has to connect, and a first Timeline read with nothing on screen to answer, before the app
        // says so (Engine.swift patience)
        val PATIENCE = 30.seconds
        const val PROBE = "const r = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' }); const j = await r.json().catch(() => ({})); " +
            "return r.status + ' ' + (j.authenticated === true ? 'signed in' : 'signed out' + (j.reason ? ' (' + j.reason + ')' : ''))"

        // a url's host and path, for the sign-in log
        fun where(url: String?): Pair<String, String> {
            val m = url?.let { Regex("^[a-z]+://([^/?#]+)([^?#]*)").find(it) } ?: return "none" to ""
            return m.groupValues[1] to m.groupValues[2]
        }

        // timeline-sample.json, its times minutes from now ("{{min:-40}}", "{{ms:+44}}") so the page always reads as today's,
        // and its words' times and days (Times.sample: {{hm:N}}, {{day:N}}, {{date:N}}) as the iPhone's showSample fills them
        fun sampleRows(text: String, now: Instant): List<Row> {
            val filled = Regex("\"\\{\\{(min|ms):([+-]?\\d+)\\}\\}\"").replace(Times.sample(text, now)) { m ->
                val at = now + (m.groupValues[2].toLong() * 60).seconds
                if (m.groupValues[1] == "ms") at.toEpochMilliseconds().toString() else "\"" + at + "\""
            }
            return json.decodeFromString(filled)
        }
    }
}

// a set value as the engine takes it ({ ref, label } or { text })
fun Value.asJson(): Map<String, String> = listOfNotNull(ref?.let { "ref" to it }, label?.let { "label" to it }, text?.let { "text" to it }).toMap()

// The last Timeline read, kept on this phone (Platform.files: never in a backup) and drawn at launch while Tana connects,
// as the desktop draws its cached rows before its sync client exists; the read that follows takes its place (Engine.swift
// SavedTimeline). Only your own account's and never in demo mode (Engine), and of a day gone by only what happened:
// Today's Tasks and Upcoming meetings come with the read, as does a free time that has ended.
object SavedTimeline {
    private const val KEY = "timeline"
    @kotlinx.serialization.Serializable private class Saved(val account: String, val at: Double, val rows: List<Row>)

    // rows: as engine.js answered them, kept as they came
    fun save(files: Store, rows: String, account: String, now: Instant) =
        files.set(KEY, "{\"account\":" + JsonPrimitive(account) + ",\"at\":" + now.toEpochMilliseconds() / 1000.0 + ",\"rows\":" + rows + "}")

    fun load(files: Store, now: Instant, zone: TimeZone = TimeZone.currentSystemDefault()): Pair<String, List<Row>>? {
        val saved = files.get(KEY)?.let { runCatching { json.decodeFromString<Saved>(it) }.getOrNull() } ?: return null
        val today = Instant.fromEpochMilliseconds((saved.at * 1000).toLong()).toLocalDateTime(zone).date == now.toLocalDateTime(zone).date
        val ms = now.toEpochMilliseconds().toDouble()
        return saved.account to saved.rows.filter { row -> if (today) (row.timeline?.free?.until ?: Double.POSITIVE_INFINITY) > ms else !row.top }
    }

    fun forget(files: Store) = files.set(KEY, null)
}

// what a call answers, or null when it threw; a cancelled coroutine stays cancelled
suspend fun <T> maybe(block: suspend () -> T): T? = try {
    block()
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    null
}
