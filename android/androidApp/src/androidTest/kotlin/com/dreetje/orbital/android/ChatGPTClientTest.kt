package com.dreetje.orbital.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.dreetje.orbital.json
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

// What ChatGPT's token endpoint answers, read as the app reads it: a sign-in that OpenAI accepted must not fail on the
// phone for want of a serializer (the app module's own @Serializable classes need the serialization plugin)
@RunWith(AndroidJUnit4::class)
class ChatGPTClientTest {
    @Test fun anAcceptedSignInsTokensAreRead() {
        val answer = """{"id_token":"i.d.t","access_token":"a.c.c","refresh_token":"r","token_type":"Bearer","expires_in":3600,"scope":"openid"}"""
        val tokens = json.decodeFromString<ChatGPTClient.Tokens>(answer)
        assertEquals("a.c.c", tokens.accessToken)
        assertEquals(tokens, json.decodeFromString<ChatGPTClient.Tokens>(json.encodeToString(tokens))) // kept on the phone and read back
    }
}
