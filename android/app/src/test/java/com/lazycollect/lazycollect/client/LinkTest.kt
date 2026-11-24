package com.lazycollect.lazycollect.client

import android.app.Application
import android.content.Intent
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], application = Application::class)
class LinkTest {
    private val token = "ca_" + "a".repeat(43)
    private val bases = listOf("https://collect.alazy.app", "http://10.0.2.2:8790")

    private fun view(url: String, flags: Int = 0) = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(flags)

    @Test
    fun onlyTheAppsOwnHostsAreAccepted() {
        assertEquals(token, appLinkToken("https://collect.alazy.app/c/$token", bases))
        assertEquals(token, appLinkToken("http://10.0.2.2:8790/c/$token", bases))
        assertNull(appLinkToken("https://evil.example/c/$token", bases))
        assertNull(appLinkToken("http://collect.alazy.app/c/$token", bases))
        assertNull(appLinkToken("https://collect.alazy.app.evil.example/c/$token", bases))
        assertNull(appLinkToken("http://10.0.2.2:9999/c/$token", bases))
    }

    @Test
    fun theAddressHasToBeALinkToAChecklist() {
        assertNull(appLinkToken("https://collect.alazy.app/c/short", bases))
        assertNull(appLinkToken("https://collect.alazy.app/x/$token", bases))
        assertNull(appLinkToken("https://collect.alazy.app/c/$token/more", bases))
        assertNull(appLinkToken("https://collect.alazy.app/", bases))
        assertNull(appLinkToken("not a url", bases))
    }

    @Test
    fun onlyAViewIntentCarriesALink() {
        assertEquals(token, view("https://collect.alazy.app/c/$token").collectToken(bases))
        assertNull(Intent(Intent.ACTION_MAIN, Uri.parse("https://collect.alazy.app/c/$token")).collectToken(bases))
    }
}
