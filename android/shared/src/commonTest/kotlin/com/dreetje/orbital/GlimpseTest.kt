package com.dreetje.orbital

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.time.Instant

// The Activity widget's lines (Glimpse.activity): each task once, at the latest thing that happened to it
class GlimpseTest {
    private fun entry(id: String, uri: String?, day: String, vararg added: String) =
        Row(id, timeline = Row.Info(uri = uri, day = day, time = "12:00"), children = added.map { Row(it, title = it) }.ifEmpty { null })

    @Test fun aTaskShowsOnceAtTheLatestThingThatHappenedToIt() {
        val glimpse = Glimpse(0, listOf(
            entry("completed a", "tana:text:a", "2026-10-03"),
            entry("accepted b", "tana:text:b", "2026-10-03"),
            entry("added a, b and c", null, "2026-10-02", "tana:text:a", "tana:text:b", "tana:text:c"),
            entry("Lunch", "tana:event:l", "2026-10-02"),
            entry("added a", null, "2026-10-01", "tana:text:a"),
        ))
        val days = glimpse.activity(Instant.parse("2026-10-04T10:00:00Z"))
        // completed and accepted stay; the line that added three keeps only c; the day that added only a is gone
        assertEquals(listOf(listOf("completed a", "accepted b"), listOf("added a, b and c", "Lunch")), days.map { (_, lines) -> lines.map { it.first.id } })
        assertEquals(listOf("tana:text:c"), days[1].second[0].second.map { it.id })
    }

    // a line about a task's state is the task: its own id, its title alone, the state the line left it in
    @Test fun aStatusLineIsTheTaskItself() {
        val line = Row("timeline:status:tana:text:a", icon = "apply", timeline = Row.Info(uri = "tana:text:a"),
            segments = listOf(Row.Segment("Priya Shah ", person = true), Row.Segment("completed"), Row.Segment(" "), Row.Segment("Plan the offsite", content = true)))
        val task = line.asTask()!!
        assertEquals(Triple("tana:text:a", "Plan the offsite", "closed"), Triple(task.id, task.title, task.stateType))
        assertEquals(null, line.copy(icon = "updated").asTask()) // an edit stays a line of its own
        // ticked back on from the widget since: the tick the app keeps on the line (Engine.glimpse), not the line's icon
        assertEquals("open", line.copy(stateType = "open").asTask()!!.stateType)
    }
}
