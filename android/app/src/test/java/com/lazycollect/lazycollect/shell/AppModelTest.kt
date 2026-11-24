package com.lazycollect.lazycollect.shell

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import com.lazycollect.lazycollect.data.Session
import com.lazycollect.lazycollect.data.TokenStore
import com.lazycollect.lazycollect.net.Api
import com.lazycollect.lazycollect.net.FakeServer
import com.lazycollect.lazycollect.net.FirmUpdate
import com.lazycollect.lazycollect.net.Me
import com.lazycollect.lazycollect.net.json
import com.lazycollect.lazycollect.net.ok
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], application = Application::class)
class AppModelTest {
    private val server = FakeServer()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val file = File(ApplicationProvider.getApplicationContext<Application>().noBackupFilesDir, "session.bin")
    private val store = TokenStore(file, { "s:$it" }, { it.removePrefix("s:") })
    private val session = Session(store).also { it.start("saved-token") }
    private val api = Api(server.url, token = { session.token.value }, onSignedOut = session::end, onPlanEnded = session::planHasEnded)

    @After
    fun stop() {
        scope.cancel()
        server.close()
    }

    private fun me(role: String = "owner", closedAt: String = "null") =
        ok("""{"user":{"id":"u1","email":"a@b.co","name":null,"role":"$role"},"firm":{"id":"f1","name":"Firm","tz":"America/Toronto","plan_status":"active","closed_at":$closedAt}}""")

    private suspend fun ready(model: AppModel): Me = withTimeout(10_000) { (model.me.first { it !is MeState.Loading } as MeState.Ready).me }

    @Test
    fun aSavedTokenLoadsTheAccount() = runBlocking {
        server.on("GET /api/me", me())
        val model = AppModel(scope, api, session)
        assertEquals("Firm", ready(model).firm.name)
        assertEquals("Bearer saved-token", server.calls("GET /api/me").single().headers["Authorization"])
    }

    @Test
    fun aRejectedTokenSignsOut() = runBlocking {
        server.on("GET /api/me", json(401, """{"error":"unauthorized"}"""))
        val model = AppModel(scope, api, session)
        withTimeout(10_000) { model.me.first { it is MeState.Failed } }
        assertNull(session.token.value)
        assertNull(store.load())
    }

    @Test
    fun signingOutCallsTheServerAndForgetsTheToken() = runBlocking {
        server.on("GET /api/me", me())
        server.on("POST /api/auth/logout", ok())
        val model = AppModel(scope, api, session)
        ready(model)
        model.signOut()
        withTimeout(10_000) { while (session.token.value != null) delay(10) }
        val logout = server.calls("POST /api/auth/logout").single()
        assertEquals("1", logout.headers["X-Collect"])
        assertEquals("Bearer saved-token", logout.headers["Authorization"])
        assertNull(store.load())
    }

    @Test
    fun signingOutWorksWithNoConnection() = runBlocking {
        server.on("GET /api/me", me())
        val model = AppModel(scope, api, session)
        ready(model)
        server.stop()
        model.signOut()
        withTimeout(10_000) { while (session.token.value != null) delay(10) }
        assertNull(store.load())
    }

    @Test
    fun aReopenErrorDoesNotOutliveTheSession() = runBlocking {
        server.on("GET /api/me", me())
        server.on("POST /api/account/reopen", json(409, """{"error":"expired"}"""))
        val model = AppModel(scope, api, session)
        ready(model)
        model.reopen()
        withTimeout(10_000) { model.action.first { it.error == "expired" } }
        session.end()
        withTimeout(10_000) { model.action.first { it.error == null && !it.busy } }
        assertNull(model.action.value.error)
    }

    @Test
    fun devicesAreForgottenOnReset() = runBlocking {
        server.on("GET /api/sessions", ok("""[{"id":"s1","label":"Phone","created_at":1,"last_seen_at":2,"current":true}]"""))
        val devices = DevicesModel(scope, api)
        devices.load()
        withTimeout(10_000) { devices.state.first { it.devices != null } }
        devices.reset()
        assertNull(devices.state.value.devices)
    }

    @Test
    fun aDevicesAnswerForTheOldAccountIsDropped() = runBlocking {
        server.on("GET /api/sessions", ok("""[{"id":"s1","label":"Phone","created_at":1,"last_seen_at":2,"current":true}]"""))
        val devices = DevicesModel(scope, api)
        devices.load()
        devices.reset()
        delay(300)
        assertNull(devices.state.value.devices)
    }

    @Test
    fun theFirmFormStartsEmptyAfterAReset() = runBlocking {
        server.on("GET /api/firm", ok("""{"name":"Old","tz":"America/Toronto"}"""))
        val firm = FirmModel(scope, api) {}
        firm.load()
        withTimeout(10_000) { firm.state.first { it.firm != null } }
        firm.reset()
        assertNull(firm.state.value.firm)
    }

    @Test
    fun aPlanThatEndedIsForgottenOnceTheServerSaysItWorks() = runBlocking {
        server.on("GET /api/me", me(), me())
        session.planHasEnded()
        val model = AppModel(scope, api, session)
        ready(model)
        assertFalse(session.planEnded.value)
    }

    @Test
    fun aPlanThatEndedIsRemembered() = runBlocking {
        server.on("GET /api/me", me())
        server.on("PATCH /api/firm", json(402, """{"error":"plan"}"""))
        val firm = FirmModel(scope, api) {}
        firm.save(FirmUpdate("N", "", "", "", "", "America/Toronto"))
        withTimeout(10_000) { firm.state.first { it.error != null } }
        assertTrue(session.planEnded.value)
    }
}
