package com.lazycollect.lazycollect.client

import kotlin.io.path.createTempDirectory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CameraFilesTest {
    private val dir = createTempDirectory("camera").toFile()

    @Test
    fun oldShotsGoButTheOneBeingTakenStays() {
        listOf("a.jpg", "b.jpg", "pending.jpg").forEach { dir.resolve(it).writeText("x") }
        clearCameraFiles(dir, "pending.jpg")
        assertEquals(listOf("pending.jpg"), dir.list()!!.toList())
        clearCameraFiles(dir, null)
        assertTrue(dir.list()!!.isEmpty())
        dir.deleteRecursively()
    }

    @Test
    fun aMissingFolderIsFine() {
        clearCameraFiles(dir.resolve("none"), null)
        dir.deleteRecursively()
    }
}
