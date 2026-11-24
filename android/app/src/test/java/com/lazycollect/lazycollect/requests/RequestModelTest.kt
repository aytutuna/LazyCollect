package com.lazycollect.lazycollect.requests

import com.lazycollect.lazycollect.net.Api
import com.lazycollect.lazycollect.net.FakeServer
import com.lazycollect.lazycollect.net.RequestItem
import com.lazycollect.lazycollect.net.json
import com.lazycollect.lazycollect.net.ok
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RequestModelTest {
    private val server = FakeServer()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var ended = 0
    private val api = Api(server.url, token = { "t" }, onSignedOut = {}, onPlanEnded = { ended++ })

    @After
    fun stop() {
        scope.cancel()
        server.close()
    }

    private fun file(id: String, mime: String = "image/jpeg") = """{"id":"$id","name":"$id.jpg","size":1200,"mime":"$mime","uploaded_at":1700000000000,"sent_back_at":null}"""

    private fun item(id: String, status: String = "submitted", kind: String = "file", files: List<String> = listOf(file("f-$id")), extra: String = "") =
        """{"id":"$id","position":1,"label":"Passport","help":null,"required":true,"status":"$status","kind":"$kind","reject_note":null,"reject_reasons":[],"unavailable_note":null,
        "answer":null,"answer_at":null,"hidden":false,"person_pos":null,"expiry_rule":null,"files":[${files.joinToString(",")}]$extra}"""

    private fun detail(vararg items: String, status: String = "open") =
        ok("""{"id":"r1","client_id":"c1","title":"Study permit","note":null,"deadline":1800000000000,"status":"$status","sent_at":1700000000000,"first_opened_at":null,"reminders_on":true,"next_reminder_at":null,"people":[],"items":[${items.joinToString(",")}]}""")

    private fun thread(vararg notes: String, unanswered: Int = 0) = ok("""{"notes":[${notes.joinToString(",")}],"unanswered":$unanswered}""")

    private val note = """{"id":"n1","author":"client","body":"Is a scan fine?","created_at":1700000000000}"""

    @Volatile private var changes = 0

    private fun model(): RequestModel {
        server.on("GET /api/requests", ok("""{"rows":[],"next":null,"counts":{"all":1},"client":{"id":"c1","name":"Ana Silva"}}"""))
        server.on("GET /api/requests/r1/notes", thread(note, unanswered = 1))
        return RequestModel(scope, api, "r1") { changes++ }
    }

    private suspend fun RequestModel.settled(check: (RequestState) -> Boolean) = withTimeout(10_000) { state.first { !it.busy && check(it) } }

    private fun body(route: String) = Json.parseToJsonElement(server.calls(route).last().body!!.utf8()).jsonObject

    @Test
    fun theRequestItsClientAndTheThreadAreLoaded() = runBlocking {
        server.on("GET /api/requests/r1", detail(item("i1")))
        val model = model()
        model.load()
        val state = model.settled { it.thread != null && it.clientName.isNotEmpty() }
        assertEquals("Study permit", state.request!!.title)
        assertEquals("Ana Silva", state.clientName)
        assertEquals(1, state.thread!!.unanswered)
        assertEquals("Is a scan fine?", state.thread.notes.single().body)
        assertEquals("c1", server.calls("GET /api/requests").single().url.queryParameter("client"))
    }

    @Test
    fun aRequestThatCannotBeLoadedSaysWhy() = runBlocking {
        server.on("GET /api/requests/r1", json(404, """{"error":"not_found"}"""))
        val model = model()
        model.load()
        assertEquals("not_found", model.settled { it.loadError != null }.loadError)
    }

    @Test
    fun aFailedRefreshKeepsWhatWasShownAndSaysItIsOld() = runBlocking {
        server.on("GET /api/requests/r1", detail(item("i1")), json(500, """{"error":"server_error"}"""))
        val model = model()
        model.load()
        model.settled { it.request != null }
        model.load()
        val state = model.settled { it.stale }
        assertEquals("Study permit", state.request!!.title)
        assertNull(state.loadError)
    }

    @Test
    fun approvingNamesTheFilesTheReviewerSawAndTheAnswerTime() = runBlocking {
        val shown = item("i1", files = listOf(file("a"), file("b"))).replace("\"answer_at\":null", "\"answer_at\":1700000005000")
        server.on("GET /api/requests/r1", detail(shown), detail(item("i1", "approved")))
        server.on("POST /api/requests/r1/items/i1/review", ok("{}"))
        val model = model()
        model.load()
        val loaded = model.settled { it.request != null }.request!!.items.single()
        model.approve(loaded)
        val state = model.settled { it.request!!.items.single().status == "approved" }
        val sent = body("POST /api/requests/r1/items/i1/review")
        assertEquals("approve", sent["decision"]!!.jsonPrimitive.content)
        assertEquals(listOf("a", "b"), sent["files"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(1700000005000, sent["answered_at"]!!.jsonPrimitive.content.toLong())
        assertFalse(sent.containsKey("reasons"))
        assertEquals("1", server.calls("POST /api/requests/r1/items/i1/review").single().headers["X-Collect"])
        assertEquals(1, changes)
        assertNull(state.error)
    }

    @Test
    fun aSendBackCarriesTheReasonsInTheServersOrderAndTheTrimmedNote() = runBlocking {
        server.on("GET /api/requests/r1", detail(item("i1")))
        server.on("POST /api/requests/r1/items/i1/review", ok("{}"))
        val model = model()
        model.load()
        val loaded = model.settled { it.request != null }.request!!.items.single()
        model.reject(loaded, setOf("glare", "blurry"), "  Retake it  ")
        model.settled { server.calls("POST /api/requests/r1/items/i1/review").isNotEmpty() }
        val sent = body("POST /api/requests/r1/items/i1/review")
        assertEquals("reject", sent["decision"]!!.jsonPrimitive.content)
        assertEquals(listOf("blurry", "glare"), sent["reasons"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals("Retake it", sent["note"]!!.jsonPrimitive.content)
    }

    @Test
    fun aSendBackWithoutWhatItNeedsIsNotSent() = runBlocking {
        server.on("GET /api/requests/r1", detail(item("i1"), item("q1", kind = "yesno", files = emptyList())))
        val model = model()
        model.load()
        val items = model.settled { it.request != null }.request!!.items
        model.reject(items[0], emptySet(), "just a note")
        model.reject(items[0], setOf("other"), "  ")
        model.reject(items[1], emptySet(), "")
        assertEquals(0, server.calls("POST /api/requests/r1/items/i1/review").size)
        assertEquals(0, server.calls("POST /api/requests/r1/items/q1/review").size)
    }

    @Test
    fun aQuestionCanGoBackWithOnlyANote() = runBlocking {
        server.on("GET /api/requests/r1", detail(item("q1", kind = "text", files = emptyList())))
        server.on("POST /api/requests/r1/items/q1/review", ok("{}"))
        val model = model()
        model.load()
        val question = model.settled { it.request != null }.request!!.items.single()
        model.reject(question, emptySet(), "Which year?")
        model.settled { server.calls("POST /api/requests/r1/items/q1/review").isNotEmpty() }
        val sent = body("POST /api/requests/r1/items/q1/review")
        assertEquals(0, sent["reasons"]!!.jsonArray.size)
        assertEquals("Which year?", sent["note"]!!.jsonPrimitive.content)
        assertEquals(JsonArray(emptyList()), sent["files"])
    }

    @Test
    fun theRulesForWhatASendBackNeeds() {
        assertEquals(Need.Reason, rejectNeed("file", emptySet(), ""))
        assertEquals(Need.Reason, rejectNeed("file", emptySet(), "a note is not enough for a document"))
        assertEquals(Need.Note, rejectNeed("text", emptySet(), " "))
        assertNull(rejectNeed("text", emptySet(), "why"))
        assertEquals(Need.OtherNote, rejectNeed("file", setOf("other"), ""))
        assertNull(rejectNeed("file", setOf("other"), "what is wrong"))
        assertNull(rejectNeed("file", setOf("blurry"), ""))
        assertEquals(listOf("wrong_period", "wrong_person", "other"), reasonsFor("choice"))
        assertEquals(11, reasonsFor("file").size)
    }

    @Test
    fun aDecisionOnSomethingThatChangedIsRefusedAndTheRequestIsLoadedAgain() = runBlocking {
        server.on("GET /api/requests/r1", detail(item("i1")), detail(item("i1", "submitted", files = listOf(file("f-new")))))
        server.on("POST /api/requests/r1/items/i1/review", json(409, """{"error":"stale"}"""))
        val model = model()
        model.load()
        model.approve(model.settled { it.request != null }.request!!.items.single())
        val state = model.settled { it.error != null && it.request!!.items.single().files.single().id == "f-new" }
        assertEquals("stale", state.error)
    }

    @Test
    fun theClientsReasonForNotHavingAnItemCanBeAcceptedOrAskedAgain() = runBlocking {
        server.on("GET /api/requests/r1", detail(item("i1", "unavailable", files = emptyList())))
        server.on("POST /api/requests/r1/items/i1/unavailable", ok("{}"))
        val model = model()
        model.load()
        val loaded = model.settled { it.request != null }.request!!.items.single()
        model.waive(loaded)
        model.settled { server.calls("POST /api/requests/r1/items/i1/unavailable").size == 1 }
        assertEquals("accept", body("POST /api/requests/r1/items/i1/unavailable")["decision"]!!.jsonPrimitive.content)
        model.askAgain(loaded, "   ")
        assertEquals(1, server.calls("POST /api/requests/r1/items/i1/unavailable").size)
        model.askAgain(loaded, " Ask your employer ")
        model.settled { server.calls("POST /api/requests/r1/items/i1/unavailable").size == 2 }
        val sent = body("POST /api/requests/r1/items/i1/unavailable")
        assertEquals("ask", sent["decision"]!!.jsonPrimitive.content)
        assertEquals("Ask your employer", sent["note"]!!.jsonPrimitive.content)
    }

    @Test
    fun aReminderIsSentAndANoticeSaysSo() = runBlocking {
        server.on("GET /api/requests/r1", detail(item("i1", "empty", files = emptyList())))
        server.on("POST /api/requests/r1/remind", ok("""{"ok":true,"sent_at":1700000000000}"""))
        val model = model()
        model.load()
        model.settled { it.request != null }
        model.remind()
        assertTrue(model.settled { it.reminded }.reminded)
    }

    @Test
    fun aReminderTheServerRefusesSaysWhy() = runBlocking {
        server.on("GET /api/requests/r1", detail(item("i1", "empty", files = emptyList())))
        server.on("POST /api/requests/r1/remind", json(429, """{"error":"too_soon","next_at":1700086400000}"""))
        val model = model()
        model.load()
        model.settled { it.request != null }
        model.remind()
        val state = model.settled { it.error != null }
        assertEquals("too_soon", state.error)
        assertFalse(state.reminded)
    }

    @Test
    fun theLinkIsShownOrSaidToBeMissing() = runBlocking {
        server.on("GET /api/requests/r1", detail(item("i1")))
        server.on("GET /api/requests/r1/link", ok("""{"url":"https://collect.alazy.app/c/abc","expires_at":1800000000000}"""), ok("""{"url":null}"""))
        val model = model()
        model.load()
        model.settled { it.request != null }
        model.showLink()
        assertEquals("https://collect.alazy.app/c/abc", model.settled { it.link != null }.link)
        model.showLink()
        val state = model.settled { it.link == null && it.linkNote == "missing" }
        assertNull(state.link)
    }

    @Test
    fun aNewLinkCanBeEmailedAndSaysWhetherItWas() = runBlocking {
        server.on("GET /api/requests/r1", detail(item("i1")))
        server.on("POST /api/requests/r1/link", ok("""{"url":"https://collect.alazy.app/c/new","emailed":true}"""), ok("""{"url":"https://collect.alazy.app/c/newer","email_failed":true}"""), ok("""{"url":"https://collect.alazy.app/c/plain"}"""))
        val model = model()
        model.load()
        model.settled { it.request != null }
        model.makeLink(true)
        assertEquals("emailed", model.settled { it.link == "https://collect.alazy.app/c/new" }.linkNote)
        assertEquals(true, body("POST /api/requests/r1/link")["send_email"]!!.jsonPrimitive.content.toBoolean())
        model.makeLink(true)
        assertEquals("email_failed", model.settled { it.link == "https://collect.alazy.app/c/newer" }.linkNote)
        model.makeLink(false)
        assertNull(model.settled { it.link == "https://collect.alazy.app/c/plain" }.linkNote)
        assertEquals(false, body("POST /api/requests/r1/link")["send_email"]!!.jsonPrimitive.content.toBoolean())
    }

    @Test
    fun aLinkIsRefusedWhenThePlanHasEnded() = runBlocking {
        server.on("GET /api/requests/r1", detail(item("i1")))
        server.on("POST /api/requests/r1/link", json(402, """{"error":"plan"}"""))
        val model = model()
        model.load()
        model.settled { it.request != null }
        model.makeLink(false)
        val state = model.settled { it.error != null }
        assertEquals("plan", state.error)
        assertNull(state.link)
        assertEquals(1, ended)
    }

    @Test
    fun aReplyIsSentTrimmedAndTheThreadIsLoadedAgain() = runBlocking {
        server.on("GET /api/requests/r1", detail(item("i1")))
        val mine = """{"id":"n2","author":"user","body":"Yes, a scan is fine.","created_at":1700000100000}"""
        server.on("GET /api/requests/r1/notes", thread(note, unanswered = 1), thread(note, mine))
        server.on("POST /api/requests/r1/notes", json(201, """{"note":$mine,"emailed":true,"email":"sent"}"""))
        val model = RequestModel(scope, api, "r1")
        server.on("GET /api/requests", ok("""{"rows":[],"next":null,"counts":null,"client":{"id":"c1","name":"Ana Silva"}}"""))
        model.load()
        model.settled { it.thread != null }
        model.reply("   ")
        assertEquals(0, server.calls("POST /api/requests/r1/notes").size)
        model.reply("  Yes, a scan is fine.  ")
        val state = model.settled { it.replied == "sent" && it.thread!!.notes.size == 2 }
        assertEquals(0, state.thread!!.unanswered)
        assertEquals("Yes, a scan is fine.", body("POST /api/requests/r1/notes")["body"]!!.jsonPrimitive.content)
    }

    @Test
    fun aCompleteRequestIsStillReviewableButAClosedOneIsNot() {
        val base = com.lazycollect.lazycollect.net.RequestDetail("r", "c", "t", null, 1L, "complete")
        assertTrue(base.reviewable)
        assertFalse(base.copy(status = "closed").reviewable)
        assertFalse(base.copy(status = "draft").reviewable)
        assertTrue(base.copy(status = "draft").editable)
        assertFalse(base.copy(status = "expired").editable)
    }

    @Test
    fun anAnswerReadsAsOneLineWhateverItsShape() {
        fun answered(a: kotlinx.serialization.json.JsonElement?) = RequestItem("i", "Q", status = "submitted", kind = "multi", answer = a).answerText
        assertEquals("", answered(null))
        assertEquals("yes", answered(JsonPrimitive("yes")))
        assertEquals("a, b", answered(JsonArray(listOf(JsonPrimitive("a"), JsonPrimitive("b")))))
    }
}
