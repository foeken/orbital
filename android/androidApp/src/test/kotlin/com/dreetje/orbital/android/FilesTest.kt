package com.dreetje.orbital.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch

// Platform.files: a write never waits on the disk where the screen asks for it, lands in the order asked, and a read
// right after it has it all the same
class FilesTest {
    @Test fun writesLandLaterInOrderAndReadBackAtOnce() {
        val dir = File.createTempFile("orbital", "store").apply { delete() }
        val files = Files(dir)
        val held = CountDownLatch(1)
        Files.writer.execute { held.await() } // the disk busy: set must not wait for it
        for (i in 1..50) files.set("timeline", "read $i")
        files.set("gone", "x"); files.set("gone", null)
        assertFalse("nothing written while the disk is busy", File(dir, "timeline").exists())
        assertEquals("read 50", files.get("timeline"))
        assertNull(files.get("gone"))
        held.countDown()
        Files.flush()
        assertEquals("read 50", File(dir, "timeline").readText())
        assertFalse(File(dir, "gone").exists())
        assertEquals("read 50", Files(dir).get("timeline"))
        dir.deleteRecursively()
    }
}
