package com.lazycollect.lazycollect.scan

import java.io.File
import java.util.UUID
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], application = android.app.Application::class)
class PagePipelineTest {
    private val folders = ArrayList<File>()

    @After
    fun cleanUp() = folders.forEach { it.deleteRecursively() }

    private val photo = RgbaImage.filled(120, 160, 30, 30, 30)

    @Test
    fun aTurnedPageSwapsItsSidesAndKeepsTheTurns() {
        val straight = PagePipeline.wholePage(photo, CaptureFilter.Original)!!
        val turned = PagePipeline.wholePage(photo, CaptureFilter.Original, turns = 5)!!
        assertEquals(1, turned.turns)
        assertEquals(straight.width, turned.height)
        assertEquals(straight.height, turned.width)
    }

    @Test
    fun aDarkFlatPhotoIsMarkedAsDark() {
        val page = PagePipeline.wholePage(photo, CaptureFilter.Original)!!
        assertTrue(PageIssue.Dark in page.issues)
        assertTrue(!page.accepted)
    }

    @Test
    fun aCutPageKeepsTheIssuesOfTheCornersItWasCutAlong() {
        val corners = Quad(Pt(0.0, 0.0), Pt(120.0, 0.0), Pt(120.0, 160.0), Pt(0.0, 160.0))
        val page = PagePipeline.page(photo, corners, CaptureFilter.Original, confidence = 0.4)!!
        assertTrue(PageIssue.Cut in page.issues)
    }

    @Test
    fun turnsIssuesAndTheChoiceToKeepThePageSurviveTheStore() {
        val folder = File(System.getProperty("java.io.tmpdir"), "scan-pipeline-" + UUID.randomUUID()).also { folders.add(it) }
        val store = ScanPageStore(folder)
        val page = PagePipeline.wholePage(photo, CaptureFilter.Grayscale, turns = 3)!!.copy(accepted = true)
        store.save(page, byteArrayOf(1))
        val back = ScanPageStore(folder).load().single()
        assertEquals(page, back)
        assertEquals(3, back.turns)
        assertTrue(back.accepted)
    }
}
