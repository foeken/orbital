package com.dreetje.orbital

import kotlinx.datetime.LocalDate
import kotlinx.datetime.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Instant

class ListsTest {
    // a search field over people (Assign to, Quick Add's assignee, Visibility's people): all while empty, any case
    @Test fun peopleMatchingWhatWasTyped() {
        val people = listOf(Member("1", "Priya Shah"), Member("2", "Stan"))
        assertEquals(people, people.matching(""))
        assertEquals(listOf("Priya Shah"), people.matching("pri").map { it.name })
    }

    private val now = Instant.parse("2026-10-02T12:00:00Z")
    private val utc = TimeZone.UTC

    // the day the engine put each row under (ios/engine/labels.js), not one the phone works out from its time: d has no
    // time of its own, and was drawn under Today
    @Test fun daysGroupByTheEnginesDayAndLeaveTheBlocksAbove() {
        fun entry(id: String, day: String, title: String) = Row(id, createdAt = "2026-10-02T09:00:00Z", timeline = Row.Info(day = day, dayTitle = title))
        val rows = listOf(
            Row("today", timeline = Row.Info(today = true)),
            entry("a", "2026-10-02", "Friday 2 October"),
            entry("b", "2026-10-01", "Thursday 1 October"),
            entry("c", "2026-09-29", "Tuesday 29 September"),
            Row("d", timeline = Row.Info(day = "2026-09-29", dayTitle = "Tuesday 29 September")),
        )
        val days = Lists.days(rows, now, utc)
        assertEquals(listOf("Today", "Yesterday", "Tuesday 29 September"), days.map { it.first })
        assertEquals(listOf("c", "d"), days[2].second.map { it.id })
    }

    @Test fun sectionsFollowTheSearchsGroups() {
        val s = Lists.sections(listOf(Row("1", group = "Today"), Row("2", group = "Today"), Row("3", group = "Later"), Row("4")))
        assertEquals(listOf("Today", "Later", null), s.map { it.first })
        assertEquals(2, s[0].second.size)
    }

    @Test fun anOutlineFlattensWithDepthAndDropsBlankLines() {
        val flat = Lists.flat(listOf(Row("1", text = "One", children = listOf(Row("1.1", text = "Deeper"))), Row("2", text = " ")))
        assertEquals(listOf("1" to 0, "1.1" to 1), flat.map { it.first.id to it.second })
    }

    @Test fun aNameHeadsEachRunOfReplies() {
        val a = Row("1", text = "Tana", chat = Row.Chat(author = "tana"))
        val b = Row("2", text = "Tana", chat = Row.Chat(author = "tana"))
        val mine = Row("3", chat = Row.Chat(mine = true))
        assertTrue(Lists.named(a, null))
        assertFalse(Lists.named(b, a))
        assertFalse(Lists.named(mine, b))
        assertTrue(Lists.named(b, Row("s", chat = Row.Chat(status = true))))
    }

    @Test fun dotsWaitTwoMinutesForAnAnswerAtMost() {
        val mine = listOf(Row("1", chat = Row.Chat(mine = true)))
        assertTrue(Lists.waiting(mine, now - 1.minutes, now))
        assertFalse(Lists.waiting(mine, now - 3.minutes, now))
        assertTrue(Lists.waiting(listOf(Row("2", chat = Row.Chat(streaming = true))), null, now))
        assertFalse(Lists.waiting(listOf(Row("2", chat = Row.Chat(streaming = true), children = listOf(Row("w", text = "Hi")))), null, now))
    }

    @Test fun timesInWordsAsTheiPhoneSaysThem() {
        assertEquals("09:05", Times.hm(Instant.parse("2026-10-02T09:05:00Z"), utc)) // as the desktop's rail (renderer/timeline.js timelineTime)
        assertEquals("Today", Times.day("2026-10-02", "Friday 2 October", now, utc))
        assertEquals("Yesterday", Times.day("2026-10-01", "Thursday 1 October", now, utc))
        assertEquals("Tuesday 29 September", Times.day("2026-09-29", "Tuesday 29 September", now, utc))
        assertEquals("Thursday 1 October", Times.long(LocalDate(2026, 10, 1)))
        assertEquals("now", Times.relative(now, now, utc))
        assertEquals("5 minutes ago", Times.relative(now - 5.minutes, now, utc))
        assertEquals("1 hour ago", Times.relative(now - 1.hours, now, utc))
        assertEquals("yesterday", Times.relative(now - 1.days, now, utc))
        assertEquals("last week", Times.relative(now - 8.days, now, utc))
    }

    // -sample: the invented rows worded as the engine words a real one, minutes from now
    @Test fun theSampleIsWordedAsTheEngineWouldWordIt() {
        assertEquals("""["11:20","2026-10-02","2026-10-01","Thursday 1 October",{"x":"{{min:-40}}"}]""",
            Times.sample("""["{{hm:-40}}","{{day:-40}}","{{day:-1500}}","{{date:-1500}}",{"x":"{{min:-40}}"}]""", now, utc))
    }

    @Test fun plainDatesRoundTrip() {
        assertEquals("tana:plaindate:2026-03-04", Lists.plainDate(2026, 3, 4))
        assertEquals(Triple(2026, 3, 4), Lists.parsePlainDate("tana:plaindate:2026-03-04"))
        assertNull(Lists.parsePlainDate("tana:zoneddate:2026-03-04"))
    }

    @Test fun accessNamesItsRuleAndWhetherItGrants() {
        val shared = Access("T", "me", true, audience = "people", restricted = true, participants = listOf("p"), rules = listOf("me", "people"))
        assertEquals("people", shared.rule)
        assertTrue(shared.grants)
        assertEquals("inherit", shared.copy(restricted = false).rule)
        assertEquals("me", shared.copy(participants = emptyList()).rule)
        assertEquals("Kor, Stan and Jeroen", listOf(Member("1", "Kor"), Member("2", "Stan"), Member("3", "Jeroen")).names)
    }
}
