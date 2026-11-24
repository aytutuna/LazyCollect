package com.lazycollect.lazycollect.client

import android.app.Application
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.io.IOException
import java.io.InputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], application = Application::class)
class PrepareTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()
    private val prepared = File(context.cacheDir, "prepared")

    private class Breaking(private var left: Int) : InputStream() {
        override fun read(): Int {
            if (left-- <= 0) throw IOException("gone")
            return 1
        }
    }

    @Test
    fun aCopyThatBreaksLeavesNothingBehind() {
        val good = Uri.parse("content://test/good")
        val bad = Uri.parse("content://test/bad")
        shadowOf(context.contentResolver).registerInputStream(good, "abc".byteInputStream())
        shadowOf(context.contentResolver).registerInputStream(bad, Breaking(10))
        try {
            Prepare(context).all(listOf(good to "a.pdf", bad to "b.pdf"), "Item")
            fail()
        } catch (e: IOException) {
            assertEquals("gone", e.message)
        }
        assertTrue(prepared.listFiles().orEmpty().isEmpty())
    }
}
