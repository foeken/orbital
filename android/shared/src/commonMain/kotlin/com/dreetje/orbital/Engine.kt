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
    private val now: () -> Instant = { Clock.System.now() },
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
    val translator = Translator(platform.files, platform.ai, platform::language, scope)
    var sensitiveIds by mutableStateOf(setOf<String>()) // marked sensitive in Orbital (synced), for the long-press menu
        private set
    var pinned by mutableStateOf(setOf<String>()) // pinned to a day, any day, for the long-press menu
        private set
    var removed by mutableStateOf(setOf<String>()) // deleted here: gone from every list at once, before Tana confirms it
        private set
    var unpinned by mutableStateOf(setOf<String>()) // pins being taken off here, out of Today's Tasks before Tana answers
        private set
    var reveal by mutableStateOf(false) // sensitive items shown, after a shake; never kept
    var assigning by mutableStateOf<Assigning?>(null) // Assign to …: the task whose picker is open
    var asking by mutableStateOf<ShareAsk?>(null) // someone just assigned who cannot open it: Grant access or Keep private
    var shared by mutableStateOf<Shared?>(null) // shared to Orbital from another app: Quick Add opens with it

    // Settings' Demo mode, as the desktop's: made-up words and names on screen, nothing saved (ios/engine/demo.js); kept on this phone
    private var demoOn by mutableStateOf(demoMode ?: (platform.store.get("demoMode") == "true"))
    var demo: Boolean
        get() = demoOn
        set(on) {
            demoOn = on
            platform.store.set("demoMode", if (on) "true" else null)
            opened.clear() // a page read before it was turned on or off shows its words as they were then
            scope.launch { refresh() }
        }

    data class Assigning(val id: String, val current: List<String>?, val then: suspend () -> Unit)
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
    private var again = false // a change told while a read is under way: one more read follows it
    // the last read of each node opened, newest last: a page gone back to shows it at once while it is read again, as
    // the iPhone's NavigationStack keeps the page under the one on top (NodeScreen starts from cached(id))
    private val opened = LinkedHashMap<String, Page>()

    init {
        host?.listener = this
        if (sample != null) {
            rows = sampleRows(sample.first, now()).let { all ->
                if (history) all.filter { it.timeline?.today != true && it.timeline?.upcoming != true && it.timeline?.free == null } else all
            }
            phase = Phase.Ready
        }
    }

    fun start() {
        val host = host ?: return
        watch?.cancel()
        phase = Phase.Starting
        note("loading the session page")
        host.load(SESSION)
    }

    fun note(line: String) {
        if (log.lastOrNull()?.drop(9) == line) return
        log.add(Times.hms(now()) + " " + line)
        if (log.size > 100) log.removeAt(0)
    }

    override fun said(message: String) {
        when (message) {
            "changed" -> scope.launch { refresh() }
            "ready" -> scope.launch { connect() }
        }
    }

    // A page that never started: offline, or Tana unreachable, sign-in included, where no page of Tana's is there to say so
    override fun failed(message: String) {
        note("load failed: " + message)
        watch?.cancel()
        phase = Phase.Failed(message)
    }

    // Android stopped Tana's page to free memory and EngineWeb made a new one (onRenderProcessGone; the iPhone has no
    // such moment): started again on it, the rows kept on screen until the new read lands
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
                    host.keepCookies() // at once: the refresh may not finish
                    phase = Phase.Ready
                    refresh()
                }
                // Tana said signed in a moment ago: say so, rather than showing its sign-in again and again
                justSignedIn -> {
                    justSignedIn = false
                    phase = Phase.Failed("You signed in to Tana, but Orbital could not read the session. Try again.")
                }
                else -> signIn()
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            note("engine failed: " + e.message)
            phase = Phase.Failed(e.message ?: "The engine did not start")
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
                    answer = withTimeoutOrNull(10.seconds) { host.run(PROBE) }?.jsonPrimitive?.contentOrNull ?: answer
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
        if (phase != Phase.Ready || isSample) return
        if (loading) { again = true; return }
        loading = true
        // a read cut off midway (the screen that asked went away) still lets the next one through: with loading left
        // set, every refresh after it only said "again" and the Timeline never moved
        try { read() } finally { loading = false }
        if (again) { again = false; refresh() }
    }

    private suspend fun read() {
        val host = host ?: return
        val started = session
        try {
            val read: List<Row> = call("orbital.demo(demo); return await orbital.timeline(pages)", mapOf("pages" to pages, "demo" to demo))
            if (started != session) return // signed out meanwhile
            rows = read
            error = null
            settle(rows)
            maybe { call<Setup>("return await orbital.setup()") }?.let { setup ->
                translator.use(setup.to, setup.ai)
                if (translator.catalogue.isEmpty()) maybe { platform.ai.models() }?.takeIf { it.isNotEmpty() }?.let { translator.catalogue = it } // once: what this account may ask
                sensitiveIds = setup.sensitive.toSet()
                pinned = setup.pinned.toSet()
            }
            maybe { host.run("return orbital.issues()").jsonArray.map { it.jsonPrimitive.content } }?.forEach(::note)
            host.keepCookies() // Tana rotates the session: keep the newest
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (started != session) return
            if (e.message?.contains("not authenticated") == true) signIn() // the session ran out: sign in again
            error = e.message
        }
    }

    suspend fun more() {
        if (loading) return // a second tap while the first is loading would count a page never read
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
        rows = emptyList(); states.clear(); removed = emptySet(); email = null; pages = 1; opened.clear()
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

    suspend fun createTask(title: String, type: String?, search: String? = null, assignee: String? = null, values: Map<String, Value> = emptyMap()): String {
        if (isSample) throw Failure("The sample saves nothing")
        val id: String = call("return await orbital.createTask(title, type, search, assignee, values)",
            mapOf("title" to title, "type" to type, "search" to search, "assignee" to assignee, "values" to values.mapValues { it.value.asJson() }))
        // a new task is yours alone: given to someone else, they are asked about as Assign to asks
        if (assignee != null) access(id)?.takeIf { it.hidden.isNotEmpty() }?.let { asking = ShareAsk(id, it, it.hidden) {} }
        refresh()
        return id
    }

    // The image, already a JPEG of 2048 px at most, read by ChatGPT, then made into its node (orbital.fromImage)
    suspend fun processImage(jpeg: ByteArray): String {
        if (isSample) throw Failure("The sample saves nothing")
        val read = ChatGPTText.readImage(platform.ai, jpeg, translator.to, translator.ai.getValue("model"), translator.ai.getValue("effort"))
        val id: String = call("return await orbital.fromImage(kind, title, notes, image, 'image/jpeg')",
            mapOf("kind" to (read.kind ?: "doc"), "title" to (read.title ?: ""), "notes" to (read.notes ?: emptyList()), "image" to Base64.encode(jpeg)))
        refresh()
        return id
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
        if (isSample) return // the sample writes nothing
        try {
            states[task.id] = call<String>("return await orbital.toggle(id)", mapOf("id" to task.id))
        } catch (e: Failure) {
            states[task.id] = before
            error = e.message
        }
    }

    // Long press, Move to Inbox: the task back to Tana's Inbox state (proposed)
    suspend fun moveToInbox(id: String) {
        if (demo || isSample) return
        val before = states[id]
        states[id] = "proposed"
        try {
            states[id] = call<String>("return await orbital.toggle(id, 'proposed')", mapOf("id" to id))
        } catch (e: Failure) {
            if (before == null) states.remove(id) else states[id] = before
            error = e.message
        }
    }

    fun state(task: Row): String = states[task.id] ?: task.stateType ?: if (task.done == true) "closed" else "open"

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

    private suspend inline fun <reified T> call(body: String, args: Map<String, Any?> = emptyMap()): T {
        val host = host ?: throw Failure("Not in the sample")
        try {
            val answer = host.run(body, args)
            val text = (answer as? JsonPrimitive)?.takeIf { it.isString }?.content ?: "null"
            return json.decodeFromString<T>(text)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            note((Regex("orbital\\.(\\w+)").find(body)?.groupValues?.get(1) ?: "engine") + " failed: " + e.message)
            throw Failure(e.message ?: "The engine failed")
        }
    }

    companion object {
        const val SESSION = "https://home.tana.inc/api/auth/session"
        const val HOME = "https://home.tana.inc"
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

// what a call answers, or null when it threw; a cancelled coroutine stays cancelled
suspend fun <T> maybe(block: suspend () -> T): T? = try {
    block()
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    null
}
