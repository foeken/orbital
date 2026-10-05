package com.dreetje.orbital

import com.dreetje.orbital.ui.Glyphs
import java.io.File
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.time.Instant

// ios/PhoneSpec.json, run on Android: the rules both phones keep a copy of (Ticks, Glimpse.activity and asTask, Phrases,
// Glyphs), held to the cases the iPhone runs too (ios/OrbitalUITests/SpecTests.swift)
class SpecTest {
    private val spec = json.parseToJsonElement(File(System.getProperty("orbital.repo") ?: "../..", "ios/PhoneSpec.json").readText()).jsonObject
    private val JsonElement.text: String? get() = if (this is JsonNull) null else jsonPrimitive.contentOrNull
    private fun at(seconds: JsonElement?) = Instant.fromEpochSeconds(seconds!!.jsonPrimitive.long)

    @Test fun ticks() {
        for (case in spec["ticks"]!!.jsonArray) {
            val name = case.jsonObject["name"]!!.text
            val ticks = Ticks()
            for (step in case.jsonObject["steps"]!!.jsonArray.map { it.jsonObject }) {
                val gives = step["gives"]?.text
                when {
                    "tap" in step -> assertEquals(gives, ticks.tap(step["tap"]!!.text!!, step["shown"]!!.text!!, at(step["at"])), name)
                    "set" in step -> assertEquals(gives, ticks.set(step["set"]!!.text!!, step["to"]!!.text!!, at(step["at"])), name)
                    "answer" in step -> ticks.answer(step["answer"]!!.text!!, step["state"]!!.text!!)
                    "refuse" in step -> ticks.refuse(step["refuse"]!!.text!!, step["back"]!!.text)
                    "settle" in step -> { val read = step["settle"]!!.jsonObject; ticks.settle(at(step["at"])) { read[it]?.text } }
                    "ticks" in step -> for ((id, want) in step["ticks"]!!.jsonObject) assertEquals(want.text, ticks.states[id], "$name: $id")
                    "state" in step -> assertEquals(gives, ticks.state(step["state"]!!.text!!, step["row"]!!.text, (step["done"] as? kotlinx.serialization.json.JsonPrimitive)?.booleanOrNull), name)
                    "on" in step -> assertEquals(gives, ticks.on(step["on"]!!.text!!, step["uri"]!!.text), name)
                    else -> error("$name: a step this test does not know: $step")
                }
            }
        }
    }

    @Test fun activity() {
        val a = spec["activity"]!!.jsonObject
        val rows = json.decodeFromJsonElement<List<Row>>(a["rows"]!!)
        val days = Glimpse(0, rows).activity(Instant.parse(a["now"]!!.text!!))
        val want = a["days"]!!.jsonArray.map { d -> d.jsonObject["title"]!!.text to d.jsonObject["lines"]!!.jsonArray.map { l -> l.jsonObject["id"]!!.text to l.jsonObject["added"]!!.jsonArray.map { it.text } } }
        assertEquals(want, days.map { (title, lines) -> title to lines.map { (row, added) -> row.id to added.map { it.id } } })
        for (t in a["tasks"]!!.jsonArray.map { it.jsonObject }) {
            val line = rows.first { it.id == t["line"]!!.text }.let { r -> t["stateType"]?.text?.let { r.copy(stateType = it) } ?: r }
            val task = line.asTask()
            val gives = t["gives"] as? JsonObject
            if (gives == null) assertNull(task, line.id)
            else assertEquals(listOf(gives["id"]!!.text, gives["title"]!!.text, gives["stateType"]!!.text), listOf(task?.id, task?.title, task?.stateType), line.id)
        }
    }

    @Test fun phrases() {
        val p = spec["phrases"]!!.jsonObject
        assertEquals(p["states"]!!.jsonArray.map { it.jsonArray[0].text to it.jsonArray[1].text }, Phrases.states)
        for ((state, word) in p["state"]!!.jsonObject) assertEquals(word.text, Phrases.state(state))
        for (c in p["audience"]!!.jsonArray.map { it.jsonObject }) {
            val (word, glyph) = c["gives"]!!.jsonArray.map { it.text }
            assertEquals(word to glyph, Phrases.audience(c["scope"]!!.text!!, c["space"]!!.text))
        }
        for ((status, word) in p["agent"]!!.jsonObject) assertEquals(word.text, Phrases.agent(status))
        for (c in p["free"]!!.jsonArray.map { it.jsonObject }) {
            val (a, b, d) = c["gives"]!!.jsonArray.map { it.text!! }
            assertEquals(Triple(a, b, d), Phrases.free(c["from"]!!.jsonPrimitive.double, c["until"]!!.jsonPrimitive.double, c["now"]!!.jsonPrimitive.double))
        }
        for ((kind, glyph) in p["glyphs"]!!.jsonObject) assertEquals(glyph.text, Glyphs.of(kind), kind)
        for ((icon, glyph) in p["markers"]!!.jsonObject) assertEquals(glyph.text, Glyphs.marker(icon), icon)
    }
}
