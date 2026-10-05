package com.dreetje.orbital

import androidx.compose.runtime.mutableStateMapOf
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Instant

// A task's box ticked on this phone: drawn in its new state at once, before engine.js has written it, since a tap must
// answer without a round trip through the page (Engine.toggle, tick). The state ticked stands until a read of Tana
// agrees with it, or still disagrees half a minute on (Tana refused it later than the engine waits for, or someone changed
// it back): the graph can trail a write by seconds, never by that long. One that is not in the rows read keeps its tick.
// The iPhone's ios/Common/Ticks.swift is the same, names and all, and both phones run the cases in ios/PhoneSpec.json
// (SpecTest here, SpecTests.swift there): one rule, written twice, held to one spec.
class Ticks {
    val states = mutableStateMapOf<String, String>() // task id -> the state ticked here
    private val at = mutableMapOf<String, Instant>() // task id -> when

    // what a task's box shows: a tick made here, else what Tana said, else its done
    fun state(id: String, row: String?, done: Boolean? = null): String = states[id] ?: row ?: if (done == true) "closed" else "open"
    // a tick made here on the task, or on the task a Timeline line is about (its uri), which a widget draws as the task
    fun on(id: String, uri: String? = null): String? = states[id] ?: uri?.let { states[it] }

    // a box tapped, showing shown: its next state by the desktop's rule (next), drawn at once
    fun tap(id: String, shown: String, now: Instant): String = next(shown).also { set(id, it, now) }
    // a state set outright (a widget's box, Move to Inbox, a Status picked); answers the tick it replaced, to put back
    fun set(id: String, to: String, now: Instant): String? = states[id].also { states[id] = to; at[id] = now }
    // engine.js answered with the state it wrote
    fun answer(id: String, state: String) { states[id] = state }
    // Tana refused: back to what it was (null: no tick of ours)
    fun refuse(id: String, back: String?) { if (back == null) states.remove(id) else states[id] = back }

    // a read of Tana: read answers a task's state there, null for one it does not show
    fun settle(now: Instant, read: (String) -> String?) {
        for ((id, state) in states.toMap()) {
            val was = read(id) ?: continue
            if (was == state || now - (at[id] ?: Instant.DISTANT_PAST) >= PATIENCE) states.remove(id)
        }
        at.keys.retainAll(states.keys)
    }

    fun clear() { states.clear(); at.clear() }

    companion object {
        val PATIENCE = 30.seconds
        // renderer/edit.js toggleDone: an Inbox task is accepted (In Progress) before a second tap completes it, a completed
        // one is opened again, anything else is completed
        fun next(shown: String): String = if (shown == "proposed" || shown == "closed") "open" else "closed"
    }
}
