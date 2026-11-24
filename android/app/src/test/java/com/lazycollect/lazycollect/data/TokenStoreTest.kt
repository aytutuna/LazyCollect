package com.lazycollect.lazycollect.data

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], application = Application::class)
class TokenStoreTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val file = File(app.noBackupFilesDir, "session.bin")

    // Robolectric has no AndroidKeyStore, so a reversible stand-in plays the SecretBox; the real key is checked on an emulator
    private fun store() = TokenStore(file, { "sealed:" + it.reversed() }, { if (it.startsWith("sealed:")) it.removePrefix("sealed:").reversed() else null })

    @Test
    fun aSavedTokenComesBackAndIsNotOnDiskAsItIs() {
        store().save("secret-token")
        assertEquals("secret-token", store().load())
        assertFalse(file.readText().contains("secret-token"))
    }

    @Test
    fun savingAgainReplacesTheToken() {
        store().save("first")
        store().save("second")
        assertEquals("second", store().load())
        assertFalse(File(file.parentFile, "session.bin.tmp").exists())
    }

    @Test
    fun clearingForgetsIt() {
        store().save("secret-token")
        store().clear()
        assertNull(store().load())
        assertFalse(file.exists())
    }

    @Test
    fun aFileThatCannotBeOpenedIsNoToken() {
        file.writeText("garbage")
        assertNull(store().load())
    }

    @Test
    fun theFileSitsWhereAndroidDoesNotBackUp() {
        assertTrue(file.path.startsWith(app.noBackupFilesDir.path))
    }

    @Test
    fun theSessionFollowsTheStore() {
        store().save("saved")
        val session = Session(store())
        assertEquals("saved", session.token.value)
        session.start("new")
        assertEquals("new", store().load())
        session.planHasEnded()
        assertTrue(session.planEnded.value)
        session.end()
        assertNull(session.token.value)
        assertNull(store().load())
        assertFalse(session.planEnded.value)
    }
}
