package com.lazycollect.lazycollect.net

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ApiTest {
    private val server = FakeServer()
    private var token: String? = "session-token"
    private var signedOut = 0
    private var planEnded = 0
    private val api = Api(server.url, token = { token }, onSignedOut = { signedOut++ }, onPlanEnded = { planEnded++ })

    @After
    fun stop() = server.close()

    private suspend fun failure(block: suspend () -> Unit): ApiError = try {
        block()
        throw AssertionError("expected an ApiError")
    } catch (e: ApiError) {
        e
    }

    @Test
    fun getSendsTheBearerAndNoCsrfHeader() = runBlocking {
        server.on("GET /api/me", ok(ME))
        api.me()
        val request = server.calls("GET /api/me").single()
        assertEquals("Bearer session-token", request.headers["Authorization"])
        assertNull(request.headers["X-Collect"])
    }

    @Test
    fun everyWriteSendsTheCsrfHeader() = runBlocking {
        server.on("POST /api/auth/logout", ok())
        server.on("PATCH /api/firm", ok())
        server.on("DELETE /api/sessions/s1", ok())
        server.on("POST /api/sessions/end-others", ok())
        server.on("POST /api/account/reopen", ok())
        api.logout()
        api.saveFirm(FirmUpdate("Name", "", "", "", "", "America/Toronto"))
        api.endDevice("s1")
        api.endOthers()
        api.reopen()
        assertEquals(5, server.requests.size)
        server.requests.forEach { assertEquals("1", it.headers["X-Collect"]) }
    }

    @Test
    fun noTokenMeansNoAuthorizationHeader() = runBlocking {
        token = null
        server.on("POST /api/app/challenge", ok("""{"challenge":"c","required":false}"""))
        api.challenge()
        assertNull(server.requests.single().headers["Authorization"])
    }

    @Test
    fun pendingCallsCarryThePendingTokenNotTheSession() = runBlocking {
        server.on("GET /api/auth/pending", ok("""{"step":"passkey","role":"owner","email":"a@b.co"}"""))
        val info = api.pending("held-token")
        assertEquals("owner", info.role)
        assertEquals("Pending held-token", server.requests.single().headers["Authorization"])
    }

    @Test
    fun startLeavesOutTheAttestationWhenThereIsNone() = runBlocking {
        server.on("POST /api/app/auth/start", ok())
        api.start("a@b.co", null)
        api.start("a@b.co", Attestation("c1", "t1"))
        val bodies = server.calls("POST /api/app/auth/start").map { it.body!!.utf8() }
        assertEquals("""{"email":"a@b.co","platform":"android"}""", bodies[0])
        assertEquals("""{"email":"a@b.co","attestation":{"challenge":"c1","token":"t1"},"platform":"android"}""", bodies[1])
    }

    @Test
    fun verifyReadsTheTokenOrThePendingStep() = runBlocking {
        server.on("POST /api/app/auth/verify", ok("""{"ok":true,"token":"abc"}"""), ok("""{"ok":true,"step":"enrol","pending":"p1"}"""))
        assertEquals("abc", api.verify("a@b.co", "123456").token)
        val held = api.verify("a@b.co", "123456")
        assertEquals("enrol", held.step)
        assertEquals("p1", held.pending)
    }

    @Test
    fun passkeyCallsGoThroughTheWebAuthnJson() = runBlocking {
        server.on("POST /api/auth/pending/options", ok("""{"kind":"register","options":{"challenge":"x","rp":{"id":"collect.alazy.app"}}}"""))
        server.on("POST /api/auth/pending/verify", ok("""{"ok":true,"token":"session"}"""))
        val options = api.passkeyOptions("p1")
        assertEquals("register", options.kind)
        val response: JsonObject = buildJsonObject { put("id", "cred") }
        assertEquals("session", api.passkeyVerify("p1", response, "My phone"))
        assertEquals("""{"response":{"id":"cred"},"name":"My phone"}""", server.calls("POST /api/auth/pending/verify").single().body!!.utf8())
    }

    @Test
    fun errorCodesComeFromTheBody() = runBlocking {
        server.on("GET /api/firm", json(403, """{"error":"forbidden"}"""))
        val e = failure { api.firm() }
        assertTrue(e is ApiError.Other)
        assertEquals(403, (e as ApiError.Other).status)
        assertEquals("forbidden", e.code)
    }

    @Test
    fun anErrorWithoutABodyIsAServerError() = runBlocking {
        server.on("GET /api/firm", html(502))
        assertEquals("server_error", failure { api.firm() }.code)
    }

    @Test
    fun a401WithASessionSignsOut() = runBlocking {
        server.on("GET /api/me", json(401, """{"error":"unauthorized"}"""))
        val e = failure { api.me() }
        assertTrue(e is ApiError.Unauthorized)
        assertEquals(1, signedOut)
    }

    @Test
    fun a401OnAPendingLoginDoesNotSignOut() = runBlocking {
        server.on("POST /api/auth/pending/options", json(401, """{"error":"pending_expired"}"""))
        val e = failure { api.passkeyOptions("gone") }
        assertTrue(e is ApiError.Unauthorized)
        assertEquals("pending_expired", e.code)
        assertEquals(0, signedOut)
    }

    @Test
    fun a401WithNoTokenDoesNotSignOut() = runBlocking {
        token = null
        server.on("POST /api/app/auth/verify", json(401, """{"error":"unauthorized"}"""))
        failure { api.verify("a@b.co", "1") }
        assertEquals(0, signedOut)
    }

    @Test
    fun a402SaysThePlanEnded() = runBlocking {
        server.on("PATCH /api/firm", json(402, """{"error":"plan"}"""))
        val e = failure { api.saveFirm(FirmUpdate("N", "", "", "", "", "America/Toronto")) }
        assertTrue(e is ApiError.PlanEnded)
        assertEquals(1, planEnded)
        assertEquals(0, signedOut)
    }

    @Test
    fun conflictsAndRateLimitsAreTyped() = runBlocking {
        server.on("DELETE /api/sessions/s1", json(409, """{"error":"current_session"}"""))
        server.on("POST /api/sessions/end-others", json(429, """{"error":"rate_limited"}"""))
        val conflict = failure { api.endDevice("s1") }
        assertTrue(conflict is ApiError.Conflict)
        assertEquals("current_session", conflict.code)
        val limited = failure { api.endOthers() }
        assertTrue(limited is ApiError.RateLimited)
        assertEquals("rate_limited", limited.code)
    }

    @Test
    fun aDeadServerIsANetworkError() = runBlocking {
        server.stop()
        val e = failure { api.me() }
        assertTrue(e is ApiError.Network)
        assertEquals("network", e.code)
        assertFalse(signedOut > 0)
    }

    @Test
    fun aBodyThatIsNotWhatWasPromisedIsAServerError() = runBlocking {
        server.on("GET /api/me", ok("""{"nothing":1}"""))
        assertEquals("server_error", failure { api.me() }.code)
    }

    private fun html(code: Int) = mockwebserver3.MockResponse.Builder().code(code).body("<html>bad gateway</html>").build()

    private companion object {
        const val ME = """{"user":{"id":"u1","email":"a@b.co","name":null,"role":"owner"},"firm":{"id":"f1","name":"Firm","tz":"America/Toronto","plan_status":"trialing","trial_ends_at":1,"current_period_end":null,"past_due_since":null,"cancel_at_period_end":false,"subscribed":false,"closed_at":null,"held":false,"usable":true,"region":"na"}}"""
    }
}
