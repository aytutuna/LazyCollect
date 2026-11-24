package com.lazycollect.lazycollect.ui

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], application = Application::class)
class LicencesTest {
    private val notices = ApplicationProvider.getApplicationContext<Application>().assets.open("THIRD-PARTY-NOTICES.txt").bufferedReader().use { it.readText() }

    @Test
    fun theNoticesShipInsideTheApp() {
        assertTrue(notices.startsWith("Third-party software"))
    }

    @Test
    fun theAndroidLibrariesAreListedWithTheLicenceText() {
        listOf("OkHttp", "Okio", "kotlinx.serialization", "Jetpack Compose", "Play Integrity", "Credentials").forEach { assertTrue(it, notices.contains(it)) }
        assertTrue(notices.contains("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION"))
    }
}
