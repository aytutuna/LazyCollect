package com.lazycollect.lazycollect.requests

import com.lazycollect.lazycollect.net.Api
import com.lazycollect.lazycollect.net.FakeServer
import com.lazycollect.lazycollect.net.json
import com.lazycollect.lazycollect.net.ok
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RequestsModelTest {
    private val server = FakeServer()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var ended = 0
    private val api = Api(server.url, token = { "t" }, onSignedOut = {}, onPlanEnded = { ended++ })

    @After
    fun stop() {
        scope.cancel()
        server.close()
    }

    private fun row(id: String, client: String = "Ana", submitted: Int = 1) =
        """{"id":"$id","client_id":"c1","client_name":"$client","title":"Study permit $id","deadline":1800000000000,"status":"open","empty":1,"submitted":$submitted,"approved":0,"rejected":0,"unavailable":0,"waived":0,"unanswered":0,"expiring":0,"expiring_on":null}"""

    private fun page(rows: List<String>, next: Int? = null, counts: String? = """{"all":3,"to_review":2,"waiting":1,"expiring":0,"overdue":0,"due_soon":1,"done":0}""") =
        ok("""{"rows":[${rows.joinToString(",")}],"next":${next ?: "null"},"counts":${counts ?: "null"},"client":null}""")

    private suspend fun RequestsModel.settled(check: (RequestsState) -> Boolean = { true }) = withTimeout(10_000) { state.first { !it.loading && !it.loadingMore && check(it) } }

    @Test
    fun theFirstPageComesWithTheCountsAndAsksForTheNeedsAttentionTab() = runBlocking {
        server.on("GET /api/requests", page(listOf(row("r1"), row("r2"))))
        val model = RequestsModel(scope, api)
        model.refresh()
        val state = model.settled { it.rows != null }
        assertEquals(listOf("r1", "r2"), state.rows!!.map { it.id })
        assertEquals(2, state.counts!!.toReview)
        assertEquals("Ana", state.rows[0].clientName)
        val asked = server.calls("GET /api/requests").single().url
        assertEquals("to_review", asked.queryParameter("view"))
        assertEquals("activity", asked.queryParameter("sort"))
        assertNull(asked.queryParameter("offset"))
        assertEquals("Bearer t", server.calls("GET /api/requests").single().headers["Authorization"])
    }

    @Test
    fun aTabAsksAgainWithItsOwnOrder() = runBlocking {
        server.on("GET /api/requests", page(listOf(row("r1"))))
        val model = RequestsModel(scope, api)
        model.show("waiting")
        model.settled { it.rows != null }
        val asked = server.calls("GET /api/requests").last().url
        assertEquals("waiting", asked.queryParameter("view"))
        assertEquals("deadline", asked.queryParameter("sort"))
        model.sort("newest")
        model.settled { it.sort == "newest" && it.rows != null }
        assertEquals("newest", server.calls("GET /api/requests").last().url.queryParameter("sort"))
        // another tab goes back to its own order
        model.show("all")
        model.settled { it.view == "all" }
        assertEquals("newest", model.state.value.sort)
        model.show("overdue")
        model.settled { it.view == "overdue" }
        assertEquals("deadline", model.state.value.sort)
    }

    @Test
    fun theStatusAndTheSearchGoToTheServerAsTyped() = runBlocking {
        server.on("GET /api/requests", page(listOf(row("r1"))))
        val model = RequestsModel(scope, api)
        model.filter("open")
        model.settled { it.rows != null }
        model.search("  Ana & Sons 100%  ")
        model.settled { it.query.isNotEmpty() && it.rows != null }
        val asked = server.calls("GET /api/requests").last().url
        assertEquals("open", asked.queryParameter("status"))
        assertEquals("Ana & Sons 100%", asked.queryParameter("q"))
        assertTrue(model.state.value.filtered)
    }

    @Test
    fun theNextPageIsAddedAndAsksForTheOffsetTheServerGave() = runBlocking {
        server.on("GET /api/requests", page(listOf(row("r1")), next = 50), page(listOf(row("r2")), next = null, counts = null))
        val model = RequestsModel(scope, api)
        model.refresh()
        assertEquals(50, model.settled { it.rows != null }.next)
        model.loadMore()
        val state = model.settled { it.rows?.size == 2 }
        assertEquals(listOf("r1", "r2"), state.rows!!.map { it.id })
        assertNull(state.next)
        // the counts of the first page stay
        assertEquals(3, state.counts!!.all)
        assertEquals("50", server.calls("GET /api/requests").last().url.queryParameter("offset"))
        model.loadMore()
        assertEquals(2, server.calls("GET /api/requests").size)
    }

    @Test
    fun aFailedNextPageKeepsTheRowsAndCanBeTriedAgain() = runBlocking {
        server.on("GET /api/requests", page(listOf(row("r1")), next = 50), json(500, """{"error":"server_error"}"""), page(listOf(row("r2"))))
        val model = RequestsModel(scope, api)
        model.refresh()
        model.settled { it.rows != null }
        model.loadMore()
        val failed = model.settled { it.moreError != null }
        assertEquals(listOf("r1"), failed.rows!!.map { it.id })
        assertEquals(50, failed.next)
        model.loadMore()
        assertEquals(listOf("r1", "r2"), model.settled { it.rows?.size == 2 }.rows!!.map { it.id })
    }

    @Test
    fun aFailedFirstLoadSaysWhyAndARefreshRecovers() = runBlocking {
        server.on("GET /api/requests", json(500, """{"error":"server_error"}"""), page(listOf(row("r1"))))
        val model = RequestsModel(scope, api)
        model.loadOnce()
        assertEquals("server_error", model.settled { it.error != null }.error)
        model.refresh()
        val state = model.settled { it.rows != null }
        assertNull(state.error)
        assertEquals(1, state.rows!!.size)
    }

    @Test
    fun anAccountWithNoRequestsIsAFirstRunUntilSomethingIsTyped() = runBlocking {
        server.on("GET /api/requests", page(emptyList(), counts = """{"all":0,"to_review":0,"waiting":0,"expiring":0,"overdue":0,"due_soon":0,"done":0}"""))
        val model = RequestsModel(scope, api)
        model.refresh()
        assertTrue(model.settled { it.rows != null }.firstRun)
        model.search("zzz")
        assertFalse(model.settled { it.query == "zzz" && it.rows != null }.firstRun)
    }

    @Test
    fun aPlanThatEndedIsNotAnErrorOfTheList() = runBlocking {
        server.on("GET /api/requests", json(402, """{"error":"plan"}"""))
        val model = RequestsModel(scope, api)
        model.refresh()
        assertEquals("plan", model.settled { it.error != null }.error)
        assertEquals(1, ended)
    }

    @Test
    fun resetForgetsTheListOfTheAccountThatLeft() = runBlocking {
        server.on("GET /api/requests", page(listOf(row("r1"))))
        val model = RequestsModel(scope, api)
        model.show("all")
        model.settled { it.rows != null }
        model.reset()
        assertEquals(RequestsState(), model.state.value)
    }

    @Test
    fun aChangedRequestMakesTheListLoadAgainWhenItIsShownNext() = runBlocking {
        server.on("GET /api/requests", page(listOf(row("r1"))))
        val model = RequestsModel(scope, api)
        model.loadOnce()
        model.settled { it.rows != null }
        model.loadOnce()
        assertEquals(1, server.calls("GET /api/requests").size)
        model.markOutdated()
        model.loadOnce()
        model.settled { it.rows != null && !it.outdated }
        assertEquals(2, server.calls("GET /api/requests").size)
    }

    @Test
    fun theCountOfATabIsTheServers() {
        val counts = com.lazycollect.lazycollect.net.RequestCounts(all = 9, toReview = 1, waiting = 2, expiring = 3, overdue = 4, dueSoon = 5)
        assertEquals(listOf(1, 2, 3, 4, 5, 9), VIEWS.map { counts.of(it) })
    }
}
