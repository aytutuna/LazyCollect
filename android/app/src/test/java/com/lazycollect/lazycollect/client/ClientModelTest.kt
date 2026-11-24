package com.lazycollect.lazycollect.client

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import com.lazycollect.lazycollect.data.Session
import com.lazycollect.lazycollect.data.TokenStore
import com.lazycollect.lazycollect.net.Api
import com.lazycollect.lazycollect.net.FakeServer
import com.lazycollect.lazycollect.net.json
import com.lazycollect.lazycollect.net.ok
import com.lazycollect.lazycollect.signin.Attester
import java.io.File
import kotlin.io.path.createTempDirectory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive
import java.util.concurrent.TimeUnit
import mockwebserver3.MockResponse
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
class ClientModelTest {
    private val server = FakeServer()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dir = createTempDirectory("client").toFile()
    private val store = TokenStore(File(ApplicationProvider.getApplicationContext<Application>().noBackupFilesDir, "client.bin"), { "s:$it" }, { it.removePrefix("s:") })
    private val session = Session(store)
    private val api = Api(server.url, token = { session.token.value }, onSignedOut = session::end, onPlanEnded = {})
    private val queue = UploadQueue(File(dir, "uploads"), api)
    private var kicks = 0
    private var wipes = 0
    private var proofFor: String? = null
    private val attester = Attester { hash -> proofFor = hash; "integrity-token" }

    @After
    fun stop() {
        scope.cancel()
        server.close()
        dir.deleteRecursively()
    }

    private fun model(online: StateFlow<Boolean> = MutableStateFlow(true)) = ClientModel(scope, api, session, attester, queue, online, wipe = { wipes++ }) { kicks++ }

    private fun view(vararg items: String) = ok(
        """{"firm_name":"Firm","tz":"America/Toronto","title":"Study permit","note":null,"deadline":1800000000000,"status":"open","expires_at":1900000000000,
        "contact":null,"notes":[],"people":[],"items":[${items.joinToString(",")}]}""",
    )

    private fun fileItem(id: String, status: String = "empty") = """{"id":"$id","label":"Passport","required":true,"status":"$status","kind":"file","files":[]}"""

    private suspend fun ready(model: ClientModel) = withTimeout(10_000) { model.state.first { it !is ClientState.Loading } }

    private val token = "ca_" + "a".repeat(43)

    @Test
    fun aLinkIsTradedForASessionAndTheChecklistLoads() = runBlocking {
        server.on("POST /api/app/challenge", ok("""{"challenge":"c1","required":true}"""))
        server.on("POST /api/app/client/exchange", ok("""{"token":"client-session","expires_at":1900000000000}"""))
        server.on("GET /api/c/me", view(fileItem("i1")))
        val model = model()
        model.open("https://collect.alazy.app/c/$token")
        val state = withTimeout(10_000) { model.state.first { it is ClientState.Ready } } as ClientState.Ready
        assertEquals("Study permit", state.view.title)
        val sent = server.calls("POST /api/app/client/exchange").single().body!!.utf8()
        assertTrue(sent.contains("\"token\":\"$token\""))
        assertTrue(sent.contains("integrity-token"))
        assertEquals("client-session", session.token.value)
        assertEquals("Bearer client-session", server.calls("GET /api/c/me").single().headers["Authorization"])
        assertTrue(proofFor != null)
    }

    @Test
    fun somethingThatIsNotALinkIsRefusedBeforeAnyRequest() {
        val model = model()
        model.open("hello")
        assertEquals("invalid_link", model.action.value.error)
        assertTrue(server.requests.isEmpty())
    }

    @Test
    fun aLinkThatIsGoneShowsGoneAndDropsWaitingFiles() = runBlocking {
        session.start("client-session")
        queue.add("i1", "a.jpg", "abc".byteInputStream())
        server.on("GET /api/c/me", json(404, """{"error":"not_found"}"""))
        val model = model()
        assertEquals(ClientState.Gone, ready(model))
        assertTrue(queue.jobs.value.isEmpty())
    }

    @Test
    fun aMissingItemReloadsInsteadOfEndingTheSession() = runBlocking {
        session.start("client-session")
        queue.add("i1", "a.jpg", "abc".byteInputStream())
        server.on("GET /api/c/me", view(fileItem("i1")))
        server.on("DELETE /api/c/me/files/f9", json(404, """{"error":"not_found"}"""))
        val model = model()
        ready(model)
        model.removeFile("f9")
        withTimeout(10_000) { while (server.calls("GET /api/c/me").size < 2) kotlinx.coroutines.delay(20) }
        assertTrue(model.state.value is ClientState.Ready)
        assertEquals(1, queue.jobs.value.size)
        assertEquals("client-session", session.token.value)
    }

    @Test
    fun aMissingItemOnAGoneLinkShowsGone() = runBlocking {
        session.start("client-session")
        server.on("GET /api/c/me", view(fileItem("i1")), json(404, """{"error":"not_found"}"""))
        server.on("PUT /api/c/me/items/i1/answer", json(404, """{"error":"not_found"}"""))
        val model = model()
        ready(model)
        model.answer("i1", JsonPrimitive("x"))
        withTimeout(10_000) { model.state.first { it == ClientState.Gone } }
        Unit
    }

    @Test
    fun aDeadLinkOnExchangeIsAPlainError() = runBlocking {
        server.on("POST /api/app/challenge", ok("""{"challenge":"c1","required":false}"""))
        server.on("POST /api/app/client/exchange", json(404, """{"error":"not_found"}"""))
        val model = model()
        model.open("https://collect.alazy.app/c/$token")
        withTimeout(10_000) { model.action.first { it.error != null } }
        assertEquals("not_found", model.action.value.error)
        assertEquals(ClientState.Loading, model.state.value)
        assertNull(session.token.value)
    }

    @Test
    fun anAnswerReplacesTheWholeList() = runBlocking {
        session.start("client-session")
        server.on("GET /api/c/me", view("""{"id":"q1","label":"Married?","required":true,"status":"empty","kind":"yesno","files":[]}"""))
        server.on(
            "PUT /api/c/me/items/q1/answer",
            ok("""{"items":[{"id":"q1","label":"Married?","required":true,"status":"submitted","kind":"yesno","answer":"yes","files":[]},{"id":"q2","label":"Spouse name","required":true,"status":"empty","kind":"text","files":[]}]}"""),
        )
        val model = model()
        ready(model)
        model.answer("q1", JsonPrimitive("yes"))
        val state = withTimeout(10_000) { model.state.first { it is ClientState.Ready && it.view.items.size == 2 } } as ClientState.Ready
        assertEquals("yes", state.view.items[0].answerText)
        assertEquals("""{"answer":"yes"}""", server.calls("PUT /api/c/me/items/q1/answer").single().body!!.utf8())
    }

    @Test
    fun clearingAnAnswerSendsNull() = runBlocking {
        session.start("client-session")
        server.on("GET /api/c/me", view("""{"id":"q1","label":"Name","required":true,"status":"submitted","kind":"text","answer":"x","files":[]}"""))
        server.on("PUT /api/c/me/items/q1/answer", ok("""{"items":[]}"""))
        val model = model()
        ready(model)
        model.answer("q1", null)
        withTimeout(10_000) { model.state.first { it is ClientState.Ready && it.view.items.isEmpty() } }
        assertEquals("""{"answer":null}""", server.calls("PUT /api/c/me/items/q1/answer").single().body!!.utf8())
    }

    @Test
    fun aDateIsSentAloneWhenOnlyOneIsSet() = runBlocking {
        session.start("client-session")
        server.on("GET /api/c/me", view(fileItem("i1")))
        server.on("PUT /api/c/me/items/i1/dates", ok("""{"items":[]}"""))
        val model = model()
        ready(model)
        model.dates("i1", "2027-03-31", "2027-03-31", setExpires = true, setIssued = false)
        withTimeout(10_000) { model.state.first { it is ClientState.Ready && it.view.items.isEmpty() } }
        assertEquals("""{"expires_on":"2027-03-31"}""", server.calls("PUT /api/c/me/items/i1/dates").single().body!!.utf8())
    }

    @Test
    fun aFailedRefreshKeepsWhatWasShown() = runBlocking {
        session.start("client-session")
        server.on("GET /api/c/me", view(fileItem("i1")), json(500, """{"error":"server_error"}"""))
        val model = model()
        ready(model)
        model.reload()
        val state = withTimeout(10_000) { model.state.first { it is ClientState.Ready && it.stale } } as ClientState.Ready
        assertEquals(1, state.view.items.size)
    }

    @Test
    fun filesQueuedForAnItemThatWentAreDroppedOnLoad() = runBlocking {
        session.start("client-session")
        queue.add("gone", "a.jpg", "abc".byteInputStream())
        server.on("GET /api/c/me", view(fileItem("i1")))
        val model = model()
        ready(model)
        assertTrue(queue.jobs.value.isEmpty())
        assertEquals(1, model.dropped.value)
    }

    @Test
    fun addingFilesStartsTheUploads() {
        val prepared = File(dir, "p.jpg").apply { writeText("abc") }
        val model = model()
        model.add("i1", listOf(Prepared("a.jpg", prepared, true)))
        assertEquals(1, queue.jobs.value.size)
        assertTrue(kicks >= 1)
        assertTrue(!prepared.exists())
    }

    @Test
    fun aFileThatCannotBeReadSaysSoAndLeavesNothingQueued() {
        val missing = File(dir, "gone.jpg")
        val model = model()
        model.add("i1", listOf(Prepared("a.jpg", missing, true)))
        assertEquals("file_unreadable", model.action.value.error)
        assertTrue(queue.jobs.value.isEmpty())
    }

    @Test
    fun aGoneLinkWipesTheScannedPages() = runBlocking {
        session.start("client-session")
        server.on("GET /api/c/me", json(404, """{"error":"not_found"}"""))
        val model = model()
        assertEquals(ClientState.Gone, ready(model))
        assertTrue(wipes >= 1)
    }

    @Test
    fun endingTheSessionWipesTheScannedPages() = runBlocking {
        session.start("client-session")
        server.on("GET /api/c/me", view(fileItem("i1")))
        val model = model()
        ready(model)
        val before = wipes
        session.end()
        withTimeout(10_000) { while (wipes == before) kotlinx.coroutines.delay(20) }
        assertTrue(wipes > before)
    }

    @Test
    fun aReplacedSessionWipesWhatTheOldOneLeft() = runBlocking {
        session.start("old-session")
        queue.add("i1", "a.jpg", "abc".byteInputStream())
        server.on("GET /api/c/me", view(fileItem("i1")))
        val model = model()
        ready(model)
        val before = wipes
        session.start("new-session")
        withTimeout(10_000) { while (wipes == before) kotlinx.coroutines.delay(20) }
        assertTrue(queue.jobs.value.isEmpty())
    }

    @Test
    fun leavingEndsTheSessionAndForgetsTheFiles() = runBlocking {
        session.start("client-session")
        queue.add("i1", "a.jpg", "abc".byteInputStream())
        server.on("GET /api/c/me", view(fileItem("i1")))
        server.on("POST /api/app/client/logout", ok())
        val model = model()
        ready(model)
        model.leave()
        withTimeout(10_000) { session.token.first { it == null } }
        withTimeout(10_000) { while (queue.jobs.value.isNotEmpty()) kotlinx.coroutines.delay(20) }
        assertNull(store.load())
        withTimeout(10_000) { while (server.calls("POST /api/app/client/logout").isEmpty()) kotlinx.coroutines.delay(20) }
        assertEquals(1, server.calls("POST /api/app/client/logout").size)
        assertEquals("Bearer client-session", server.calls("POST /api/app/client/logout").single().headers["Authorization"])
    }

    @Test
    fun leavingDoesNotWaitForTheServer() = runBlocking {
        session.start("client-session")
        queue.add("i1", "a.jpg", "abc".byteInputStream())
        server.on("GET /api/c/me", view(fileItem("i1")))
        server.on("POST /api/app/client/logout", MockResponse.Builder().code(200).body("{}").headersDelay(2, TimeUnit.SECONDS).build())
        val model = model()
        ready(model)
        model.leave()
        assertNull(session.token.value)
        assertTrue(queue.jobs.value.isEmpty())
    }

    @Test
    fun comingBackOnlineRefreshesTheChecklist() = runBlocking {
        session.start("client-session")
        server.on("GET /api/c/me", view(fileItem("i1")))
        val network = MutableStateFlow(false)
        val model = model(network)
        ready(model)
        assertEquals(1, server.calls("GET /api/c/me").size)
        network.value = true
        withTimeout(10_000) { while (server.calls("GET /api/c/me").size < 2) kotlinx.coroutines.delay(20) }
        assertTrue(model.connected.value)
    }

    @Test
    fun aRefreshThatFailsOnReturnStillStartsTheWaitingFiles() = runBlocking {
        session.start("client-session")
        server.on("GET /api/c/me", view(fileItem("i1")), json(503, """{"error":"server_error"}"""))
        val network = MutableStateFlow(true)
        val model = model(network)
        ready(model)
        queue.add("i1", "a.jpg", "abc".byteInputStream())
        val before = kicks
        network.value = false
        kotlinx.coroutines.delay(100)
        network.value = true
        withTimeout(10_000) { while (kicks == before) kotlinx.coroutines.delay(20) }
        assertTrue(kicks > before)
    }

    @Test
    fun aFileThatWentReloadsTheChecklist() = runBlocking {
        session.start("client-session")
        server.on("GET /api/c/me", view(fileItem("i1")), view(fileItem("i1", "submitted")))
        val model = model()
        ready(model)
        // the model may miss a file that comes and goes too quickly, so it goes again until the reload shows
        withTimeout(10_000) {
            while (server.calls("GET /api/c/me").size < 2) {
                queue.add("i1", "a.jpg", "abc".byteInputStream())
                kotlinx.coroutines.delay(20)
                queue.jobs.value.forEach { queue.remove(it.id) }
                kotlinx.coroutines.delay(20)
            }
        }
        val state = withTimeout(10_000) { model.state.first { it is ClientState.Ready && it.view.items.single().status == "submitted" } }
        assertTrue(state is ClientState.Ready)
        assertTrue(server.calls("GET /api/c/me").size >= 2)
    }

    @Test
    fun staysQuietWhenTheConnectionNeverWentAway() = runBlocking {
        session.start("client-session")
        server.on("GET /api/c/me", view(fileItem("i1")))
        val model = model(MutableStateFlow(true))
        ready(model)
        kotlinx.coroutines.delay(200)
        assertEquals(1, server.calls("GET /api/c/me").size)
    }

    @Test
    fun aNewLinkEndsTheOldSessionOnTheServer() = runBlocking {
        session.start("old-session")
        server.on("POST /api/app/challenge", ok("""{"challenge":"c1","required":false}"""))
        server.on("POST /api/app/client/exchange", ok("""{"token":"new-session","expires_at":1900000000000}"""))
        server.on("POST /api/app/client/logout", ok())
        server.on("GET /api/c/me", view(fileItem("i1")))
        val model = model()
        ready(model)
        model.open("https://collect.alazy.app/c/$token")
        withTimeout(10_000) { while (server.calls("POST /api/app/client/logout").isEmpty()) kotlinx.coroutines.delay(20) }
        assertEquals("Bearer old-session", server.calls("POST /api/app/client/logout").single().headers["Authorization"])
    }

    @Test
    fun filesPreparedForAChecklistThatWasLeftAreDroppedAndDeleted() {
        val model = model()
        val epoch = model.epoch
        queue.forget()
        val file = File(dir, "prepared.jpg").apply { writeText("abc") }
        model.add("i1", listOf(Prepared("a.jpg", file, true)), epoch)
        assertTrue(queue.jobs.value.isEmpty())
        assertTrue(!file.exists())
        assertEquals(0, kicks)
        assertTrue(File(dir, "uploads").listFiles().orEmpty().isEmpty())
    }
}
