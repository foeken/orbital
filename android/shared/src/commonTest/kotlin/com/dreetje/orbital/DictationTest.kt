package com.dreetje.orbital

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class DictationTest {
    // Android's microphone question still open when the page goes (or ✕ is tapped): granted after, nothing records
    @Test fun cancelledWhileAskedForTheMicrophoneNeverRecords() = runTest {
        val asked = CompletableDeferred<Boolean>()
        val recorder = FakeRecorder()
        val dictation = Dictation(FakePlatform(chatgpt = FakeChatGPT(signedIn = true), recorder = recorder, allowed = { asked.await() }), backgroundScope)
        launch { dictation.listen() }
        runCurrent()
        dictation.cancel()
        asked.complete(true)
        runCurrent()
        assertEquals(0, recorder.started)
        assertFalse(dictation.recording)
    }

    @Test fun grantedItRecords() = runTest {
        val recorder = FakeRecorder()
        val dictation = Dictation(FakePlatform(chatgpt = FakeChatGPT(signedIn = true), recorder = recorder, allowed = { true }), backgroundScope)
        dictation.listen()
        assertEquals(1, recorder.started)
        assertTrue(dictation.recording)
        dictation.cancel()
    }

    // Add or Send right after starting: Android keeps no recording that short (stop() is null), which is said, and
    // what is waiting to be sent waits rather than going without what was said
    @Test fun aRecordingTooShortToKeepIsSaidNotDropped() = runTest {
        val dictation = Dictation(FakePlatform(chatgpt = FakeChatGPT(signedIn = true), recorder = FakeRecorder(), allowed = { true }), backgroundScope)
        dictation.listen()
        assertFalse(dictation.settle {})
        assertEquals("Too short to write down. Try again.", dictation.problem)
        assertFalse(dictation.recording)
    }
}
