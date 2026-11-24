package com.lazycollect.lazycollect.signin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class RequestHashTest {
    // from the server's bindingHash in src/attest.ts: base64url, no padding, of SHA-256 over "<challenge>.<email>"
    @Test
    fun matchesTheServersBindingHash() {
        assertEquals("LGPAHjQYu9e8WBccTKhyslOZMU1X2X8l5bJRVgHMO_c", requestHash("Zm9vYmFy_challenge-1", "someone@example.com"))
    }

    @Test
    fun hasNoPaddingAndNoPlusOrSlash() {
        repeat(50) { n ->
            val hash = requestHash("challenge-$n", "person$n@example.com")
            assertEquals(43, hash.length)
            assertEquals(-1, hash.indexOfAny(charArrayOf('=', '+', '/')))
        }
    }

    @Test
    fun dependsOnTheChallengeAndTheEmail() {
        assertNotEquals(requestHash("a", "x@y.co"), requestHash("b", "x@y.co"))
        assertNotEquals(requestHash("a", "x@y.co"), requestHash("a", "z@y.co"))
    }
}
