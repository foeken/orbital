package com.dreetje.orbital

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlin.time.Clock
import kotlin.time.Instant

// The engine's answers, read leniently: it may add a field the phone does not draw yet
val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }

// One row as the desktop renderer gets it: of the Timeline (main/timeline.js), a saved search or a meeting's documents
// (ios/engine/index.js listRow), an outline (sdk/content.js) or a chat (sdk/chat.js); only what the app draws, as
// ios/Orbital/Timeline.swift Row has it.
@Serializable
data class Row(
    val id: String,
    val text: String? = null,
    val title: String? = null,
    val segments: List<Segment>? = null,
    val icon: String? = null,
    val createdAt: String? = null,
    val unread: Boolean? = null,
    val done: Boolean? = null,
    val stateType: String? = null,
    val subtext: String? = null,
    val start: String? = null,
    val join: String? = null,
    val people: List<Person>? = null,
    val assignees: List<String>? = null, // a task's, in a saved search: who it is assigned to, for Assign to …
    val children: List<Row>? = null,
    val timeline: Info? = null,
    val reference: Ref? = null,
    val heading: Int? = null,
    val block: String? = null,
    val type: String? = null,
    val meta: String? = null,
    val note: Boolean? = null,
    val chat: Chat? = null,
    val sensitive: Boolean? = null, // marked sensitive in Orbital: drawn barred until a shake shows it (ios/engine/sensitive.js)
    val group: String? = null, // the section a saved search files it under (ios/engine/arrange.js)
    val glyph: String? = null, // a saved search's own icon, a PNG in base64 (ios/engine/index.js iconPng)
) {
    // content: the node's own words in a sentence of the app's (main/timeline.js), person: a person's name; the widgets'
    // Activity draws a line from them, title first (Widgets.kt Brief)
    @Serializable data class Segment(val text: String? = null, val marks: Marks? = null, val mention: Ref? = null, val content: Boolean? = null, val person: Boolean? = null)
    @Serializable data class Marks(val bold: Boolean? = null, val italic: Boolean? = null, val strike: Boolean? = null, val code: Boolean? = null, val link: String? = null)
    @Serializable data class Ref(val uri: String, val label: String? = null)
    @Serializable data class Chat(val mine: Boolean? = null, val status: Boolean? = null, val streaming: Boolean? = null, val author: String? = null)
    @Serializable data class Person(val name: String)
    @Serializable data class Free(val from: Double, val until: Double)
    @Serializable data class Info(
        val uri: String? = null,
        val note: String? = null,
        val change: String? = null,
        val detail: String? = null,
        val tone: String? = null,
        val today: Boolean? = null,
        val upcoming: Boolean? = null,
        val free: Free? = null,
        val recording: Boolean? = null, // a meeting under way whose call is being recorded or transcribed (main/timeline.js)
        // an entry's time on the rail, the day it is under (YYYY-MM-DD) and that day in words, in the desktop's own
        // formatting (ios/engine/labels.js); the blocks above the days have a time of their own ('Now', '') and no day
        val time: String? = null,
        val day: String? = null,
        val dayTitle: String? = null,
    )

    val instant: Instant get() = createdAt?.let(::parseTime) ?: Clock.System.now()
    val words: String get() = listOfNotNull(title, text, reference?.label).firstOrNull { it.isNotEmpty() } ?: ""
    val tone: String? get() = timeline?.tone
    // above the days: Today's Tasks, the free time and Upcoming meetings (main/timeline.js pageOf)
    val top: Boolean get() = timeline?.today == true || timeline?.upcoming == true || timeline?.free != null
    // the node a tap on this row zooms into: what it refers to, or the row itself when it is a node (an outline
    // block's own id is not)
    val target: String? get() = reference?.uri ?: id.takeIf { it.startsWith("tana:") }
    // an empty line with nothing under it, which a new task's content often is only: left out, so it draws no lone bullet
    val blank: Boolean get() = words.isBlank() && segments.isNullOrEmpty() && type == null && children.isNullOrEmpty()
}

// Tana's times, with or without fractional seconds ("2026-09-30T13:00:00Z", "…:00.000Z")
fun parseTime(s: String): Instant? = runCatching { Instant.parse(s) }.getOrNull()

// A node zoomed into (orbital.open): its title, its kind and what it holds
@Serializable data class Page(val title: String, val kind: String, val rows: List<Row> = emptyList(), val sensitive: Boolean? = null)

// What a refresh reads besides the rows (orbital.setup)
@Serializable data class Setup(val to: String? = null, val ai: Map<String, String> = emptyMap(), val sensitive: List<String> = emptyList(), val pinned: List<String> = emptyList(),
                               val agents: List<Agent>? = null, val handed: Map<String, String>? = null)

// Your Dot (ios/engine/agents.js, ui/Agents.kt): the agents linked through orbital.md, a node's agent and its last Agent status
// line, a link code with the two servers and the message for your Dot, and what became of the code
@Serializable data class Agent(val id: String, val name: String, val app: String = "", val on: Boolean = false, val isDefault: Boolean = false)
@Serializable data class HandedTo(val id: String, val name: String, val status: String = "assigned") {
    // as the Mac's badge reads it: Assigned is waiting for the agent to pick it up
    val word: String get() = mapOf("assigned" to "Assigned", "working" to "Working", "completed" to "Completed", "failed" to "Failed")[status] ?: "Assigned"
}
@Serializable data class AgentList(val agents: List<Agent> = emptyList(), val handed: Map<String, String> = emptyMap(), val problem: String? = null)
@Serializable data class LinkCode(val code: String, val expiresAt: Double, val url: String, val tana: String, val prompt: String)
@Serializable data class LinkState(val state: String, val expiresAt: Double? = null, val agent: Linked? = null) {
    @Serializable data class Linked(val id: String, val name: String, val app: String? = null)
}

@Serializable data class Member(val id: String, val name: String)

// A zoomed node's Assigned to and Visible to (orbital.access)
@Serializable data class Audience(val scope: String, val space: String? = null)

@Serializable
data class Access(
    val title: String,
    val me: String,
    val task: Boolean,
    val assignees: List<Member> = emptyList(),
    val audience: String,
    val space: String? = null,
    val people: List<Member> = emptyList(),
    val hidden: List<Member> = emptyList(),
    val restricted: Boolean = false,
    val participants: List<String> = emptyList(),
    val rules: List<String> = emptyList(),
    val reason: String? = null,
    val inherit: Audience = Audience("inherit"),
    val token: String? = null,
    val agent: HandedTo? = null, // the linked agent it is handed to (ui/Agents.kt)
) {
    // Grant access is the pill's write (renderer/access.js hiddenFromFix): only where the node's own list is its audience
    val grants: Boolean get() = restricted && "people" in rules
    // the rule it is shared by now, as the visibility picker ticks it
    val rule: String get() = if (!restricted) "inherit" else if (participants.isEmpty()) "me" else "people"
}

// Quick Add Task's types (orbital.taskTypes), a saved search's preset (orbital.searchPreset), a type's fields
// (orbital.typeFields) and a value set in one
@Serializable data class TaskType(val uri: String? = null, val title: String, val task: Boolean? = true)
@Serializable data class Value(val ref: String? = null, val label: String? = null, val text: String? = null)
@Serializable data class Preset(val uri: String, val title: String, val task: Boolean, val fields: Map<String, Value> = emptyMap())
@Serializable data class Field(val key: String, val title: String, val kind: String, val options: List<String> = emptyList())

// A message written into a chat: which chat, and a warning when Tana did not take it up (it is sent all the same)
@Serializable data class Sent(val id: String, val warning: String? = null)

// pages-sample.json: invented saved searches and pages for -sample
@Serializable data class Sample(val searches: List<Row> = emptyList(), val pages: Map<String, Page> = emptyMap())

class Failure(message: String) : Exception(message)

// "Kor", "Kor and Stan", "Kor, Stan and Jeroen" (renderer/access.js namesOf)
val List<Member>.names: String get() = if (size > 1) dropLast(1).joinToString(", ") { it.name } + " and " + last().name else firstOrNull()?.name ?: ""
val List<Member>.persons: List<Row.Person> get() = map { Row.Person(it.name) }

// a node's kind from its id (tana:<kind>:<ulid>)
fun kindOf(uri: String): String? = uri.split(":").getOrNull(1)
