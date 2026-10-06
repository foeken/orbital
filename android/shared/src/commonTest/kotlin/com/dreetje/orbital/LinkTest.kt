package com.dreetje.orbital

import com.dreetje.orbital.ui.Link
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

// orbital: links as the iPhone's Shell.swift open takes them: a widget's, a launcher shortcut's, Assistant's, any app's
class LinkTest {
    private val id = "tana:text:00000000000000000000000d01"

    // through Orbital's own way in (its widgets, tile, shortcuts): what the iPhone does with each
    @Test fun eachLinkTheIPhoneTakes() {
        assertEquals(Link.Add, Link.parse("orbital:add", own = true))
        assertEquals(Link.Timeline, Link.parse("orbital:timeline", own = true))
        assertEquals(Link.Open(id), Link.parse("orbital:$id", own = true))
        assertEquals(Link.Tick(id, "closed"), Link.parse("orbital:check:$id", own = true))
        assertEquals(Link.Tick(id, "open"), Link.parse("orbital:uncheck:$id", own = true))
        assertEquals(Link.Pin(id, true), Link.parse("orbital:pin:$id", own = true))
        assertEquals(Link.Pin(id, false), Link.parse("orbital:unpin:$id", own = true))
        assertEquals(Link.New("Buy milk & eggs", true), Link.parse("orbital:new?title=%20Buy%20milk%20%26%20eggs&today=1", own = true))
        assertEquals(Link.New("Café", false), Link.parse("orbital:new?title=Caf%C3%A9", own = true))
    }

    // from any other app (Assistant included) a write is not made: it opens where you can make it yourself
    @Test fun anotherAppsWriteOnlyOpensWhereYouCanMakeIt() {
        for (write in listOf("check:", "uncheck:", "pin:", "unpin:")) assertEquals(Link.Open(id), Link.parse("orbital:$write$id"))
        assertEquals(Link.Fill("Buy milk"), Link.parse("orbital:new?title=Buy%20milk&today=1"))
        // what only opens is the same from anyone
        assertEquals(Link.Add, Link.parse("orbital:add"))
        assertEquals(Link.Timeline, Link.parse("orbital:timeline"))
        assertEquals(Link.Open(id), Link.parse("orbital:$id"))
    }

    // a widget's link as Uri.fromParts writes it (Widgets.kt openApp): its colons encoded
    @Test fun aWidgetsEncodedLink() {
        assertEquals(Link.Tick(id, "closed"), Link.parse("orbital:check%3A" + id.replace(":", "%3A"), own = true))
    }

    @Test fun anythingElseIsNothing() {
        assertNull(Link.parse("https://home.tana.inc"))
        assertNull(Link.parse("orbital:new?title=%20"))
        assertNull(Link.parse("orbital:new"))
        assertNull(Link.parse("orbital:check:tana:text:short"))
        assertNull(Link.parse("orbital:tana:text:00000000000000000000000d01/../x"))
        assertNull(Link.parse("orbital:delete:$id"))
    }

    // a block whose image has no tanaUri (sdk/content.js) comes without one: the page still opens
    @Test fun anImageWithoutItsUriStillReads() {
        val page = json.decodeFromString<Page>("""{"title":"Plan","kind":"text","rows":[{"id":"b1","type":"image","image":{}}]}""")
        assertNull(page.rows.single().image!!.uri)
    }
}
