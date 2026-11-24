package com.lazycollect.lazycollect.client

import com.lazycollect.lazycollect.net.Api
import com.lazycollect.lazycollect.net.FakeServer
import com.lazycollect.lazycollect.net.json
import com.lazycollect.lazycollect.ui.percentText
import java.io.ByteArrayInputStream
import kotlin.io.path.createTempDirectory
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UploadProgressTest {
    private val server = FakeServer()
    private val dir = createTempDirectory("progress").toFile()
    private val api = Api(server.url, token = { "client-token" }, onSignedOut = {}, onPlanEnded = {})
    private val created = json(201, """{"id":"f1","name":"a.jpg","size":3,"uploaded_at":1}""")

    @After
    fun stop() {
        server.close()
        dir.deleteRecursively()
    }

    @Test
    fun theBodyReportsBytesSentAndEndsAtItsLength() = runBlocking {
        server.on("PUT /api/c/me/items/i1/files", created)
        val file = dir.resolve("big.bin").apply { writeBytes(ByteArray(1_000_000) { it.toByte() }) }
        val seen = mutableListOf<Long>()
        api.upload("i1", "big.bin", "u1", file) { seen += it }
        assertEquals(1_000_000L, seen.last())
        assertEquals(seen.sorted(), seen)
        assertTrue("throttled to about a percent", seen.size in 2..120)
        assertEquals(1_000_000, server.calls("PUT /api/c/me/items/i1/files").single().body?.size?.toInt())
    }

    @Test
    fun theQueueListsTheFileInFlightAndNothingAfter() = runBlocking {
        server.on("PUT /api/c/me/items/i1/files", created)
        val q = UploadQueue(dir.resolve("q"), api)
        val job = q.add("i1", "a.jpg", ByteArrayInputStream(ByteArray(500_000)))
        val seen = mutableListOf<Map<String, Float>>()
        val collector = launch(Dispatchers.Unconfined, start = CoroutineStart.UNDISPATCHED) { q.progress.collect { seen += it } }
        q.run()
        collector.cancel()
        val shown = seen.filter { it.isNotEmpty() }
        assertTrue(shown.isNotEmpty())
        assertTrue(shown.all { it.keys == setOf(job.id) && it.getValue(job.id) in 0f..1f })
        assertEquals(1f, shown.last().getValue(job.id), 0f)
        assertTrue(q.progress.value.isEmpty())
    }

    @Test
    fun aFailedTryClearsTheProgress() = runBlocking {
        server.on("PUT /api/c/me/items/i1/files", json(503, """{"error":"server_error"}"""))
        val q = UploadQueue(dir.resolve("q"), api)
        q.add("i1", "a.jpg", ByteArrayInputStream(ByteArray(1000)))
        assertEquals(Pass.Later, q.run())
        assertTrue(q.progress.value.isEmpty())
    }

    @Test
    fun percentsRoundDownAndStayInRange() {
        assertEquals("0%", percentText(0f))
        assertEquals("42%", percentText(0.429f))
        assertEquals("100%", percentText(1f))
        assertEquals("100%", percentText(1.2f))
    }
}
