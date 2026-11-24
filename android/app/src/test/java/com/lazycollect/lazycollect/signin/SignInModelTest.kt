package com.lazycollect.lazycollect.signin

import android.app.Application
import android.content.Context
import androidx.lifecycle.SavedStateHandle
import androidx.test.core.app.ApplicationProvider
import com.lazycollect.lazycollect.net.Api
import com.lazycollect.lazycollect.net.FakeServer
import com.lazycollect.lazycollect.net.json
import com.lazycollect.lazycollect.net.ok
import java.security.GeneralSecurityException
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], application = Application::class)
class SignInModelTest {
    private val server = FakeServer()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val host: Context = ApplicationProvider.getApplicationContext()
    private val hashes = CopyOnWriteArrayList<String>()
    private val tokens = CopyOnWriteArrayList<String>()
    private var attesterFails = false
    private var passkeyFails: String? = null
    private var passkeyGate: CompletableDeferred<Unit>? = null

    private val attester = Attester { hash ->
        if (attesterFails) throw IllegalStateException("no Play Services")
        hashes += hash
        "integrity-${hashes.size}"
    }

    private val passkeys = object : Passkeys {
        val used = CopyOnWriteArrayList<String>()

        override suspend fun create(host: Context, options: JsonObject): JsonObject {
            passkeyFails?.let { throw PasskeyFailed(it) }
            used += "create"
            return buildJsonObject { put("id", "new-credential") }
        }

        override suspend fun get(host: Context, options: JsonObject): JsonObject {
            passkeyGate?.await()
            passkeyFails?.let { throw PasskeyFailed(it) }
            used += "get"
            return buildJsonObject { put("id", "known-credential") }
        }
    }

    private val api = Api(server.url, token = { null }, onSignedOut = {}, onPlanEnded = {})
    private var saveFails = false
    private val model = SignInModel(scope, api, attester, passkeys) {
        if (saveFails) throw GeneralSecurityException("key lost")
        tokens += it
    }

    @After
    fun stop() {
        scope.cancel()
        server.close()
    }

    private fun challenges(vararg required: Boolean) =
        server.on("POST /api/app/challenge", *required.mapIndexed { i, r -> ok("""{"challenge":"challenge-${i + 1}","required":$r}""") }.toTypedArray())

    private suspend fun settled(until: (SignInState) -> Boolean = { true }): SignInState =
        withTimeout(10_000) { model.state.first { !it.busy && until(it) } }

    private suspend fun toCodeStep() {
        challenges(true)
        server.on("POST /api/app/auth/start", ok())
        model.sendCode("Someone@Example.com ")
        settled { it.step == Step.Code }
    }

    @Test
    fun emailThenCodeGivesATokenAndStartsTheSession() = runBlocking {
        toCodeStep()
        assertEquals("someone@example.com", model.state.value.email)
        server.on("POST /api/app/auth/verify", ok("""{"ok":true,"token":"session-1"}"""))
        model.verify(" 123456 ")
        settled { tokens.isNotEmpty() }
        assertEquals(listOf("session-1"), tokens.toList())
        assertTrue(server.calls("POST /api/app/auth/verify").single().body!!.utf8().contains(""""code":"123456""""))
        assertEquals(SignInState(), model.state.value)
    }

    @Test
    fun theIntegrityTokenIsBoundToTheChallengeAndTheEmail() = runBlocking {
        toCodeStep()
        assertEquals(requestHash("challenge-1", "someone@example.com"), hashes.single())
        val body = server.calls("POST /api/app/auth/start").single().body!!.utf8()
        assertTrue(body, body.contains(""""attestation":{"challenge":"challenge-1","token":"integrity-1"}"""))
        assertTrue(body, body.contains(""""email":"someone@example.com""""))
    }

    @Test
    fun theCodeStepSurvivesTheProcessBeingKilled() = runBlocking {
        val saved = SavedStateHandle()
        val first = SignInModel(scope, api, attester, passkeys, saved) { tokens += it }
        challenges(true)
        server.on("POST /api/app/auth/start", ok())
        first.sendCode("Someone@Example.com")
        withTimeout(10_000) { first.state.first { it.step == Step.Code } }
        withTimeout(10_000) { while (saved.get<String>("email") != "someone@example.com") delay(10) }
        val again = SignInModel(scope, api, attester, passkeys, SavedStateHandle(saved.keys().associateWith { saved.get<Any>(it) })) { tokens += it }
        assertEquals(SignInState(Step.Code, "someone@example.com"), again.state.value)
    }

    @Test
    fun theAddressIsCleanedLikeTheServerDoesBeforeItIsHashed() = runBlocking {
        server.on("POST /api/app/challenge", ok("""{"challenge":"Zm9vYmFy_challenge-1","required":true}"""))
        server.on("POST /api/app/auth/start", ok())
        model.sendCode("\uFEFF\u00A0Someone@Example.com\u2003\uFEFF")
        settled { it.step == Step.Code }
        assertEquals("LGPAHjQYu9e8WBccTKhyslOZMU1X2X8l5bJRVgHMO_c", hashes.single())
        assertEquals("someone@example.com", model.state.value.email)
    }

    @Test
    fun noAttestationIsSentWhenTheServerDoesNotAskForOne() = runBlocking {
        challenges(false)
        server.on("POST /api/app/auth/start", ok())
        model.sendCode("someone@example.com")
        settled { it.step == Step.Code }
        assertTrue(hashes.isEmpty())
        assertTrue(!server.calls("POST /api/app/auth/start").single().body!!.utf8().contains("attestation"))
    }

    @Test
    fun everyAttemptTakesAFreshChallenge() = runBlocking {
        challenges(true, true)
        server.on("POST /api/app/auth/start", ok())
        model.sendCode("someone@example.com")
        settled { it.step == Step.Code }
        model.back()
        settled { it.step == Step.Email }
        model.sendCode("someone@example.com")
        settled { it.step == Step.Code }
        assertEquals(2, server.calls("POST /api/app/challenge").size)
        val starts = server.calls("POST /api/app/auth/start").map { it.body!!.utf8() }
        assertTrue(starts[0].contains("challenge-1"))
        assertTrue(starts[1].contains("challenge-2"))
        assertEquals(listOf(requestHash("challenge-1", "someone@example.com"), requestHash("challenge-2", "someone@example.com")), hashes.toList())
    }

    @Test
    fun aFailedStartDoesNotReuseItsChallenge() = runBlocking {
        challenges(true, true)
        server.on("POST /api/app/auth/start", json(400, """{"error":"attestation"}"""), ok())
        model.sendCode("someone@example.com")
        assertEquals("attestation", settled { it.error != null }.error)
        model.sendCode("someone@example.com")
        settled { it.step == Step.Code }
        val starts = server.calls("POST /api/app/auth/start").map { it.body!!.utf8() }
        assertTrue(starts[0].contains("challenge-1"))
        assertTrue(starts[1].contains("challenge-2"))
    }

    @Test
    fun aPhoneThatCannotBeCheckedStopsBeforeTheStartCall() = runBlocking {
        attesterFails = true
        challenges(true)
        model.sendCode("someone@example.com")
        assertEquals("attestation", settled { it.error != null }.error)
        assertEquals(Step.Email, model.state.value.step)
        assertTrue(server.calls("POST /api/app/auth/start").isEmpty())
    }

    @Test
    fun anAddressThatIsNotOneNeverReachesTheServer() = runBlocking {
        model.sendCode("not an email")
        assertEquals("invalid_email", model.state.value.error)
        assertTrue(server.requests.isEmpty())
    }

    @Test
    fun aWrongCodeStaysOnTheCodeStep() = runBlocking {
        toCodeStep()
        server.on("POST /api/app/auth/verify", json(400, """{"error":"invalid"}"""))
        model.verify("000000")
        val state = settled { it.error != null }
        assertEquals("invalid", state.error)
        assertEquals(Step.Code, state.step)
        assertTrue(tokens.isEmpty())
    }

    @Test
    fun aCodeCanLeadToAPasskeyStepAndThenASession() = runBlocking {
        toCodeStep()
        server.on("POST /api/app/auth/verify", ok("""{"ok":true,"step":"passkey","pending":"held-1"}"""))
        server.on("GET /api/auth/pending", ok("""{"step":"passkey","role":"owner","email":"someone@example.com"}"""))
        server.on("POST /api/auth/pending/options", ok("""{"kind":"authenticate","options":{"challenge":"c"}}"""))
        server.on("POST /api/auth/pending/verify", ok("""{"ok":true,"token":"session-2"}"""))
        model.verify("123456")
        val step = settled { it.step == Step.Passkey }
        assertTrue(step.owner)
        assertTrue(tokens.isEmpty())
        model.usePasskey(host, "")
        settled { tokens.isNotEmpty() }
        assertEquals(listOf("get"), passkeys.used.toList())
        assertEquals(listOf("session-2"), tokens.toList())
        assertEquals("Pending held-1", server.calls("POST /api/auth/pending/verify").single().headers["Authorization"])
    }

    @Test
    fun enrolmentCreatesAPasskeyWithTheChosenName() = runBlocking {
        toCodeStep()
        server.on("POST /api/app/auth/verify", ok("""{"ok":true,"step":"enrol","pending":"held-1"}"""))
        server.on("GET /api/auth/pending", ok("""{"step":"enrol","role":"member"}"""))
        server.on("POST /api/auth/pending/options", ok("""{"kind":"register","options":{"challenge":"c"}}"""))
        server.on("POST /api/auth/pending/verify", ok("""{"ok":true,"token":"session-3"}"""))
        model.verify("123456")
        settled { it.step == Step.Enrol }
        model.usePasskey(host, " Work phone ")
        settled { tokens.isNotEmpty() }
        assertEquals(listOf("create"), passkeys.used.toList())
        assertTrue(server.calls("POST /api/auth/pending/verify").single().body!!.utf8().contains(""""name":"Work phone""""))
    }

    @Test
    fun anExpiredPendingLoginSendsThePersonBackToTheEmail() = runBlocking {
        toCodeStep()
        server.on("POST /api/app/auth/verify", ok("""{"ok":true,"step":"passkey","pending":"held-1"}"""))
        server.on("GET /api/auth/pending", ok("""{"step":"passkey","role":"member"}"""))
        server.on("POST /api/auth/pending/options", json(401, """{"error":"pending_expired"}"""))
        model.verify("123456")
        settled { it.step == Step.Passkey }
        model.usePasskey(host, "")
        val state = settled { it.error != null }
        assertEquals("pending_expired", state.error)
        assertEquals(Step.Email, state.step)
        assertTrue(tokens.isEmpty())
        // there is nothing held any more, so the passkey button does nothing
        model.usePasskey(host, "")
        assertEquals(1, server.calls("POST /api/auth/pending/options").size)
    }

    @Test
    fun aRefusedCounterEndsTheSignInToo() = runBlocking {
        toCodeStep()
        server.on("POST /api/app/auth/verify", ok("""{"ok":true,"step":"passkey","pending":"held-1"}"""))
        server.on("GET /api/auth/pending", ok("""{"step":"passkey"}"""))
        server.on("POST /api/auth/pending/options", ok("""{"kind":"authenticate","options":{}}"""))
        server.on("POST /api/auth/pending/verify", json(403, """{"error":"passkey_counter"}"""))
        model.verify("123456")
        settled { it.step == Step.Passkey }
        model.usePasskey(host, "")
        val state = settled { it.error != null }
        assertEquals("passkey_counter", state.error)
        assertEquals(Step.Email, state.step)
    }

    @Test
    fun aClosedPasskeyPromptIsAnErrorTheyCanRetry() = runBlocking {
        toCodeStep()
        server.on("POST /api/app/auth/verify", ok("""{"ok":true,"step":"passkey","pending":"held-1"}"""))
        server.on("GET /api/auth/pending", ok("""{"step":"passkey"}"""))
        server.on("POST /api/auth/pending/options", ok("""{"kind":"authenticate","options":{}}"""))
        model.verify("123456")
        settled { it.step == Step.Passkey }
        passkeyFails = "cancelled"
        model.usePasskey(host, "")
        val state = settled { it.error != null }
        assertEquals("passkey_cancelled", state.error)
        assertEquals(Step.Passkey, state.step)
        assertNull(tokens.firstOrNull())
    }

    @Test
    fun goingBackEndsThePendingLogin() = runBlocking {
        toCodeStep()
        server.on("POST /api/app/auth/verify", ok("""{"ok":true,"step":"passkey","pending":"held-1"}"""))
        server.on("GET /api/auth/pending", ok("""{"step":"passkey"}"""))
        server.on("DELETE /api/auth/pending", ok())
        model.verify("123456")
        settled { it.step == Step.Passkey }
        model.back()
        withTimeout(10_000) { while (server.calls("DELETE /api/auth/pending").isEmpty()) kotlinx.coroutines.delay(10) }
        assertEquals("Pending held-1", server.calls("DELETE /api/auth/pending").single().headers["Authorization"])
        assertEquals(Step.Email, model.state.value.step)
    }

    @Test
    fun aTokenThatCannotBeSavedIsAnErrorAndTheNewSessionIsEnded() = runBlocking {
        toCodeStep()
        server.on("POST /api/app/auth/verify", ok("""{"ok":true,"token":"session-1"}"""))
        server.on("POST /api/auth/logout", ok())
        saveFails = true
        model.verify("123456")
        val state = settled { it.error != null }
        assertEquals("storage", state.error)
        assertEquals(Step.Email, state.step)
        assertTrue(tokens.isEmpty())
        assertEquals("Bearer session-1", server.calls("POST /api/auth/logout").single().headers["Authorization"])
    }

    private suspend fun toPasskeyStep() {
        toCodeStep()
        server.on("POST /api/app/auth/verify", ok("""{"ok":true,"step":"passkey","pending":"held-1"}"""))
        server.on("GET /api/auth/pending", ok("""{"step":"passkey"}"""))
        server.on("POST /api/auth/pending/options", ok("""{"kind":"authenticate","options":{}}"""))
        server.on("POST /api/auth/pending/verify", ok("""{"ok":true,"token":"session-2"}"""))
        model.verify("123456")
        settled { it.step == Step.Passkey }
    }

    @Test
    fun thePasskeyPromptStartsByItselfOnlyOncePerPendingLogin() = runBlocking {
        toPasskeyStep()
        passkeyFails = "cancelled"
        model.autoPasskey(host)
        assertEquals("passkey_cancelled", settled { it.error != null }.error)
        // the screen was recreated: the closed prompt stays closed until the person asks again
        model.autoPasskey(host)
        settled()
        assertEquals(1, server.calls("POST /api/auth/pending/options").size)
        passkeyFails = null
        model.usePasskey(host, "")
        settled { tokens.isNotEmpty() }
        assertEquals(listOf("session-2"), tokens.toList())
    }

    @Test
    fun aSecondPromptCannotStartWhileOneIsRunning() = runBlocking {
        toPasskeyStep()
        passkeyGate = CompletableDeferred()
        model.usePasskey(host, "")
        model.usePasskey(host, "")
        passkeyGate!!.complete(Unit)
        settled { tokens.isNotEmpty() }
        assertEquals(1, server.calls("POST /api/auth/pending/options").size)
        assertEquals(listOf("session-2"), tokens.toList())
    }

    @Test
    fun aPromptThatOutlivesItsPendingLoginChangesNothing() = runBlocking {
        toPasskeyStep()
        server.on("DELETE /api/auth/pending", ok())
        passkeyGate = CompletableDeferred()
        model.usePasskey(host, "")
        model.back()
        passkeyFails = "cancelled"
        passkeyGate!!.complete(Unit)
        settled()
        assertEquals(Step.Email, model.state.value.step)
        assertNull(model.state.value.error)
        assertTrue(tokens.isEmpty())
    }
}
