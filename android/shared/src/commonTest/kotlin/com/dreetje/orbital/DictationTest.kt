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
        val dictation = Dictation(FakePlatform(ai = FakeAI(signedIn = true), recorder = recorder, allowed = { asked.await() }), backgroundScope)
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
        val dictation = Dictation(FakePlatform(ai = FakeAI(signedIn = true), recorder = recorder, allowed = { true }), backgroundScope)
        dictation.listen()
        assertEquals(1, recorder.started)
        assertTrue(dictation.recording)
        dictation.cancel()
    }
}
