package com.lazycollect.lazycollect.client

import android.app.Application
import android.graphics.BitmapFactory
import androidx.test.core.app.ApplicationProvider
import com.lazycollect.lazycollect.scan.JpegEncoder
import com.lazycollect.lazycollect.scan.RgbaImage
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
class ScanHandOffTest {
    private val prepare = Prepare(ApplicationProvider.getApplicationContext<Application>())

    private fun page(width: Int, height: Int, shade: Int = 200) = JpegEncoder.encode(RgbaImage.filled(width, height, shade, shade, shade), false)!!

    @Test
    fun aLonePageIsOneJpegNamedAfterTheItemAndScaledToTheLimit() {
        val files = prepare.scanned(listOf(page(3000, 1000)), "Passport")
        assertEquals(listOf("Passport.jpg"), files.map { it.name })
        assertTrue(files.single().jpeg)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(files.single().file.path, bounds)
        assertEquals(2400, bounds.outWidth)
        assertEquals(800, bounds.outHeight)
    }

    @Test
    fun aSmallPageIsNotScaledUp() {
        val file = prepare.scanned(listOf(page(600, 800)), "Slip").single().file
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        assertEquals(600, bounds.outWidth)
        assertEquals(800, bounds.outHeight)
    }

    @Test
    fun anUnreadablePageLeavesNothingBehind() {
        assertTrue(prepare.scanned(listOf(page(600, 800), byteArrayOf(1, 2, 3)), "Slip").isEmpty())
    }
}
