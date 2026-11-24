package com.lazycollect.lazycollect.client

import android.app.Application
import com.lazycollect.lazycollect.net.Api
import com.lazycollect.lazycollect.net.ApiError
import com.lazycollect.lazycollect.net.FakeServer
import com.lazycollect.lazycollect.net.json
import java.io.File
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import okio.Buffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], application = Application::class)
class ExampleDrawingTest {
    private val names = listOf("passport", "t4", "bank-statement", "void-cheque", "noa")
    private fun svg(name: String) = File("../../web/public/examples/$name.svg")

    @Test
    fun anExampleIsABuiltInNameOrA32DigitId() {
        assertEquals(ExampleRef.Builtin("t4"), exampleRef("t4"))
        assertEquals(ExampleRef.Uploaded, exampleRef("0123456789abcdef0123456789abcdef"))
        assertNull(exampleRef(null))
        assertNull(exampleRef("../secret"))
        assertNull(exampleRef("0123456789ABCDEF0123456789ABCDEF"))
        assertNull(exampleRef("0123456789abcdef"))
    }

    @Test
    fun everyBuiltInDrawingReadsAndDraws() {
        for (name in names) {
            val drawing = svg(name).inputStream().use(::parseExample)
            assertEquals(400f, drawing.width)
            assertEquals(280f, drawing.height)
            assertTrue(name, drawing.shapes.size > 10)
            val bitmap = renderExample(drawing, 800)
            assertEquals(800, bitmap.width)
            assertEquals(560, bitmap.height)
        }
    }

    @Test
    fun aGroupsPaintReachesItsShapesAndAShapeCanOverrideIt() {
        val drawing = svg("t4").inputStream().use(::parseExample)
        val boxes = drawing.shapes.filterIsInstance<Shape.Rect>().filter { it.look.stroke != null && it.w == 112f }
        assertEquals(9, boxes.size)
        assertEquals(1.5f, boxes.first().look.strokeWidth)
        val label = drawing.shapes.filterIsInstance<Shape.Text>().first { it.text == "Employer" }
        assertEquals(10f, label.look.fontSize)
        val title = drawing.shapes.filterIsInstance<Shape.Text>().first { it.text == "T4" }
        assertTrue(title.look.bold)
    }

    @Test
    fun theVoidStampIsTurnedAndFaint() {
        val stamp = svg("void-cheque").inputStream().use(::parseExample).shapes.filterIsInstance<Shape.Text>().first { it.text == "VOID" }
        assertEquals(-8f, stamp.turn?.degrees)
        assertEquals(0.28f, stamp.look.fillAlpha)
        assertEquals("middle", stamp.look.anchor)
    }

    @Test
    fun anUploadedExampleComesBackAsBytesAndAFailureAsAnError() = runBlocking {
        val server = FakeServer()
        try {
            val api = Api(server.url, token = { "client-token" }, onSignedOut = {}, onPlanEnded = {})
            val png = byteArrayOf(1, 2, 3, 4, -1, -2)
            server.on("GET /api/c/me/items/i1/example", MockResponse.Builder().code(200).addHeader("Content-Type", "image/png").body(Buffer().write(png)).build())
            assertArrayEquals(png, api.example("i1"))
            assertEquals("Bearer client-token", server.calls("GET /api/c/me/items/i1/example").single().headers["Authorization"])
            server.on("GET /api/c/me/items/i2/example", json(404, """{"error":"not_found"}"""))
            try {
                api.example("i2")
                fail()
            } catch (e: ApiError) {
                assertEquals("not_found", e.code)
            }
        } finally {
            server.close()
        }
    }
}
