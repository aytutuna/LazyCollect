package com.lazycollect.lazycollect.requests

import android.app.Application
import android.graphics.Bitmap
import com.lazycollect.lazycollect.net.Api
import com.lazycollect.lazycollect.net.FakeServer
import com.lazycollect.lazycollect.net.RequestFile
import com.lazycollect.lazycollect.net.json
import java.io.ByteArrayOutputStream
import kotlin.io.path.createTempDirectory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], application = Application::class)
class PreviewTest {
    private val server = FakeServer()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val dir = createTempDirectory("review").toFile()
    private val api = Api(server.url, token = { "t" }, onSignedOut = {}, onPlanEnded = {})
    private val model = PreviewModel(scope, api, dir)

    @After
    fun stop() {
        scope.cancel()
        server.close()
        dir.deleteRecursively()
    }

    private fun file(id: String, name: String, mime: String) = RequestFile(id, name, 10, mime, 0)

    private fun bytes(body: ByteArray) = MockResponse.Builder().code(200).addHeader("Content-Type", "application/octet-stream").body(Buffer().write(body)).build()

    private suspend fun done() = withTimeout(10_000) { model.state.first { !it.loading } }

    @Test
    fun aPictureIsShownScaledDownAndKeptForSharing() = runBlocking {
        val png = ByteArrayOutputStream().also { Bitmap.createBitmap(4096, 3000, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        server.on("GET /api/files/f1", bytes(png))
        model.show(file("f1", "passport.png", "image/png"))
        val shown = done().shown as Shown.Image
        assertEquals(2048, shown.bitmap.width)
        assertEquals(1500, shown.bitmap.height)
        assertEquals("passport.png", shown.file.name)
        assertTrue(shown.file.length() > 0)
        assertEquals("Bearer t", server.calls("GET /api/files/f1").single().headers["Authorization"])
    }

    @Test
    fun aPdfIsKeptAsAFileToDraw() = runBlocking {
        server.on("GET /api/files/f2", bytes("%PDF-1.4 not really".toByteArray()))
        model.show(file("f2", "t4.pdf", "application/pdf"))
        assertTrue(done().shown is Shown.Pdf)
    }

    @Test
    fun otherTypesAreOnlyKeptSoAnotherAppCanOpenThem() = runBlocking {
        server.on("GET /api/files/f3", bytes(byteArrayOf(1, 2, 3)))
        model.show(file("f3", "photo.heic", "image/heic"))
        val shown = done().shown as Shown.Other
        assertEquals(3, shown.file.length())
    }

    @Test
    fun aPictureThatCannotBeReadFallsBackToOpenWith() = runBlocking {
        server.on("GET /api/files/f4", bytes(byteArrayOf(1, 2, 3)))
        model.show(file("f4", "broken.jpg", "image/jpeg"))
        assertTrue(done().shown is Shown.Other)
    }

    @Test
    fun aRefusalIsSaidAndShowsNothing() = runBlocking {
        server.on("GET /api/files/f5", json(429, """{"error":"rate_limited"}"""))
        model.show(file("f5", "a.png", "image/png"))
        val state = done()
        assertEquals("rate_limited", state.error)
        assertEquals(null, state.shown)
    }

    @Test
    fun closingDropsTheFilesThatWereFetched() = runBlocking {
        server.on("GET /api/files/f3", bytes(byteArrayOf(1, 2, 3)))
        model.show(file("f3", "photo.heic", "image/heic"))
        done()
        assertTrue(dir.resolve("f3").exists())
        model.close()
        assertFalse(dir.exists())
        assertEquals(PreviewState(), model.state.value)
    }

    @Test
    fun theHelpersPickWhatToDoWithAFile() {
        assertEquals(Shows.Image, showsOf("image/webp"))
        assertEquals(Shows.Pdf, showsOf("application/pdf"))
        assertEquals(Shows.Other, showsOf("image/heic"))
        assertEquals(1, sampleSize(1500, 1000))
        assertEquals(2, sampleSize(4096, 3000))
        assertEquals(4, sampleSize(8192, 100))
        assertEquals("a_b_c.pdf", safeName("a/b\\c.pdf"))
        assertEquals("file", safeName("   "))
    }
}
