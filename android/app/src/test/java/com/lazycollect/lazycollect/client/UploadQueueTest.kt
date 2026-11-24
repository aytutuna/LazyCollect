package com.lazycollect.lazycollect.client

import com.lazycollect.lazycollect.net.Api
import com.lazycollect.lazycollect.net.ApiError
import com.lazycollect.lazycollect.net.FakeServer
import com.lazycollect.lazycollect.net.json
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import kotlin.io.path.createTempDirectory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UploadQueueTest {
    private val server = FakeServer()
    private val dir = createTempDirectory("queue").toFile()
    private var signedOut = 0
    private var clock = 1_000_000_000L
    private val api = Api(server.url, token = { "client-token" }, onSignedOut = { signedOut++ }, onPlanEnded = {})
    private fun queue() = UploadQueue(dir, api) { clock }

    private val created = json(201, """{"id":"f1","name":"a.jpg","size":3,"uploaded_at":1}""")
    private fun bytes(text: String): InputStream = ByteArrayInputStream(text.toByteArray())

    @After
    fun stop() {
        server.close()
        dir.deleteRecursively()
    }

    @Test
    fun aFileGoesAsTheRawBodyWithItsLengthAndIds() = runBlocking {
        server.on("PUT /api/c/me/items/i1/files", created)
        val q = queue()
        val job = q.add("i1", "my passport.jpg", bytes("abc"))
        assertEquals(Pass.Done, q.run())
        val request = server.calls("PUT /api/c/me/items/i1/files").single()
        assertEquals("abc", request.body?.utf8())
        assertEquals("3", request.headers["Content-Length"])
        assertEquals(job.uploadId, request.headers["Upload-Id"])
        assertEquals("my%20passport.jpg", request.headers["X-File-Name"])
        assertEquals("1", request.headers["X-Collect"])
        assertEquals("Bearer client-token", request.headers["Authorization"])
        assertTrue(q.jobs.value.isEmpty())
        assertTrue(dir.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun aFileAddedDuringAPassGoesInTheSamePass() = runBlocking {
        val slow = MockResponse.Builder().code(201).addHeader("Content-Type", "application/json").body("""{"id":"f1","name":"a.jpg","size":3,"uploaded_at":1}""")
            .headersDelay(400, TimeUnit.MILLISECONDS).build()
        server.on("PUT /api/c/me/items/i1/files", slow)
        server.on("PUT /api/c/me/items/i2/files", created)
        val q = queue()
        q.add("i1", "a.jpg", bytes("abc"))
        val pass = async(Dispatchers.Default) { q.run() }
        withTimeout(5_000) { while (server.calls("PUT /api/c/me/items/i1/files").isEmpty()) delay(10) }
        q.add("i2", "b.jpg", bytes("def"))
        assertEquals(Pass.Done, pass.await())
        assertEquals(1, server.calls("PUT /api/c/me/items/i2/files").size)
        assertTrue(q.jobs.value.isEmpty())
    }

    @Test
    fun aTemporaryFailureKeepsTheFileAndTheSameUploadId() = runBlocking {
        server.on("PUT /api/c/me/items/i1/files", json(503, """{"error":"server_error"}"""), created)
        val q = queue()
        val job = q.add("i1", "a.jpg", bytes("abc"))
        assertEquals(Pass.Later, q.run())
        assertEquals(1, q.jobs.value.single().tries)
        assertEquals(Pass.Done, q.run())
        val ids = server.calls("PUT /api/c/me/items/i1/files").map { it.headers["Upload-Id"] }
        assertEquals(listOf(job.uploadId, job.uploadId), ids)
    }

    @Test
    fun aBusyReplayIsTreatedAsTemporary() = runBlocking {
        server.on("PUT /api/c/me/items/i1/files", json(409, """{"error":"busy"}"""))
        val q = queue()
        q.add("i1", "a.jpg", bytes("abc"))
        assertEquals(Pass.Later, q.run())
    }

    @Test
    fun aRefusalStopsThatFileUntilRetryIsPressed() = runBlocking {
        server.on("PUT /api/c/me/items/i1/files", json(415, """{"error":"unsupported_type"}"""), created)
        val q = queue()
        val job = q.add("i1", "a.txt", bytes("abc"))
        assertEquals(Pass.Done, q.run())
        assertEquals("unsupported_type", q.jobs.value.single().failed)
        assertEquals(Pass.Done, q.run())
        assertEquals(1, server.calls("PUT /api/c/me/items/i1/files").size)
        q.retry(job.id)
        assertNull(q.jobs.value.single().failed)
        q.run()
        assertTrue(q.jobs.value.isEmpty())
    }

    @Test
    fun aFileGivesUpAfterSixAutomaticTries() = runBlocking {
        server.on("PUT /api/c/me/items/i1/files", json(500, """{"error":"server_error"}"""))
        val q = queue()
        q.add("i1", "a.jpg", bytes("abc"))
        repeat(6) { assertEquals(Pass.Later, q.run()) }
        assertEquals(Pass.Done, q.run())
        assertEquals("server_error", q.jobs.value.single().failed)
    }

    @Test
    fun oneFileAtATimeInTheOrderAdded() = runBlocking {
        server.on("PUT /api/c/me/items/i1/files", created)
        val q = queue()
        q.add("i1", "first.jpg", bytes("1"))
        clock += 1
        q.add("i1", "second.jpg", bytes("2"))
        q.run()
        assertEquals(listOf("first.jpg", "second.jpg"), server.calls("PUT /api/c/me/items/i1/files").map { java.net.URLDecoder.decode(it.headers["X-File-Name"], "UTF-8") })
    }

    @Test
    fun theQueueSurvivesARestartAndDropsWhatIsTooOld() {
        val q = queue()
        q.add("i1", "a.jpg", bytes("abc"))
        clock += 15L * 24 * 3600 * 1000
        val fresh = q.add("i1", "b.jpg", bytes("def"))
        val after = queue()
        assertEquals(listOf(fresh.id), after.jobs.value.map { it.id })
        assertEquals(2, dir.listFiles().orEmpty().size)
    }

    @Test
    fun aFileOverTheLimitIsRefusedAndLeavesNothing() {
        val big = object : InputStream() {
            var left = MAX_UPLOAD + 1
            override fun read(): Int = if (left-- > 0) 0 else -1
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (left <= 0) return -1
                val n = minOf(len.toLong(), left).toInt()
                left -= n
                return n
            }
        }
        val q = queue()
        try {
            q.add("i1", "big.pdf", big)
            throw AssertionError("expected too_big")
        } catch (e: ApiError.Other) {
            assertEquals("too_big", e.code)
        }
        assertTrue(dir.listFiles().orEmpty().isEmpty())
        assertTrue(q.jobs.value.isEmpty())
    }

    @Test
    fun filesOfItemsThatLeftTheListAreDropped() {
        val q = queue()
        q.add("i1", "a.jpg", bytes("a"))
        q.add("i2", "b.jpg", bytes("b"))
        assertEquals(1, q.reconcile(setOf("i1")))
        assertEquals(listOf("i1"), q.jobs.value.map { it.itemId })
    }

    @Test
    fun aSessionThatEndedStopsThePass() = runBlocking {
        server.on("PUT /api/c/me/items/i1/files", json(401, """{"error":"unauthorized"}"""))
        val q = queue()
        q.add("i1", "a.jpg", bytes("abc"))
        assertEquals(Pass.SignedOut, q.run())
        assertEquals(1, signedOut)
        assertNotNull(q.jobs.value.singleOrNull())
    }

    @Test
    fun aFileMissingFromDiskIsMarkedFailed() = runBlocking {
        val q = queue()
        val job = q.add("i1", "a.jpg", bytes("abc"))
        File(dir, "${job.id}.bin").delete()
        q.run()
        assertEquals("missing_file", q.jobs.value.single().failed)
        assertFalse(server.requests.any { it.method == "PUT" })
    }
}
