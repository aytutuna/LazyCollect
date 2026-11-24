package com.lazycollect.lazycollect.client

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OnlineTest {
    private class Fake(var on: Boolean) : NetworkSource {
        var notify: (Boolean) -> Unit = {}

        override fun isOnline() = on

        override fun listen(onChange: (Boolean) -> Unit) {
            notify = onChange
        }
    }

    @Test
    fun startsFromWhatThePhoneReportsAndFollowsTheCallback() {
        val source = Fake(true)
        val online = Online(source)
        assertTrue(online.state.value)
        source.notify(false)
        assertFalse(online.state.value)
        source.notify(true)
        assertTrue(online.state.value)
    }

    @Test
    fun startsOfflineWhenThereIsNoNetwork() {
        assertFalse(Online(Fake(false)).state.value)
    }
}
