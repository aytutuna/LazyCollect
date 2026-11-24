package com.lazycollect.lazycollect.requests

import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.newSingleThreadContext
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DrawGateTest {
    @OptIn(DelicateCoroutinesApi::class)
    @Test(timeout = 20_000)
    fun closingWhileADrawRunsReturnsAtOnceAndReleasesAfterIt() {
        val released = AtomicInteger()
        val gate = DrawGate { released.incrementAndGet() }
        val started = CountDownLatch(1)
        val finish = CountDownLatch(1)
        val main = newSingleThreadContext("main")
        try {
            runBlocking(main) {
                val drawn = async(start = CoroutineStart.UNDISPATCHED) {
                    gate.draw {
                        started.countDown()
                        finish.await(10, TimeUnit.SECONDS)
                        "page"
                    }
                }
                assertTrue(started.await(10, TimeUnit.SECONDS))
                gate.close()
                assertEquals(0, released.get())
                finish.countDown()
                assertEquals("page", drawn.await())
                assertEquals(1, released.get())
                assertTrue(runCatching { gate.draw { "again" } }.exceptionOrNull() is IOException)
                gate.close()
                assertEquals(1, released.get())
            }
        } finally {
            main.close()
        }
    }

    @Test
    fun closingAnIdleGateReleasesAtOnce() {
        val released = AtomicInteger()
        val gate = DrawGate { released.incrementAndGet() }
        gate.close()
        assertEquals(1, released.get())
    }
}
