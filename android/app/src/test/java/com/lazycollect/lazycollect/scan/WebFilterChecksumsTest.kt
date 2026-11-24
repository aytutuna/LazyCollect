package com.lazycollect.lazycollect.scan

import org.junit.Assert.assertEquals
import org.junit.Test

// The pages and checksums of web/src/scan/filters.test.ts, so the phone and the browser give the same bytes for each filter.
class WebFilterChecksumsTest {
    private fun checksum(image: RgbaImage) = PhotoScenes.checksum(image)

    private fun apply(page: RgbaImage, filter: CaptureFilter) = DocumentEnhancer.enhance(page, filter.mode!!).image

    @Test
    fun theFixturesAreTheWebPixels() {
        assertEquals(0x4329E79AL, checksum(EnhancerPages.shadowed()))
        assertEquals(0x8F960753L, checksum(EnhancerPages.shadowed(stamp = false)))
        assertEquals(0x2C86F2C0L, checksum(EnhancerPages.shadowed(stamp = false, picture = true)))
        assertEquals(0xE4CFC2D5L, checksum(EnhancerPages.darkGround()))
    }

    @Test
    fun theFiltersGiveTheWebBytes() {
        val page = EnhancerPages.shadowed()
        assertEquals(0x70604295L, checksum(apply(page, CaptureFilter.Enhanced)))
        assertEquals(0xEC4526A3L, checksum(apply(page, CaptureFilter.Grayscale)))
        assertEquals(0x43422875L, checksum(apply(page, CaptureFilter.BlackAndWhite)))
        // no colour on the page: the enhanced page is stored gray
        assertEquals(0xF81468D6L, checksum(apply(EnhancerPages.shadowed(stamp = false), CaptureFilter.Enhanced)))
        assertEquals(0x13CF7A4CL, checksum(apply(EnhancerPages.shadowed(stamp = false, picture = true), CaptureFilter.Grayscale)))
    }

    @Test
    fun lightPrintOnADarkGroundComesOutTheSameInEveryFilter() {
        val page = EnhancerPages.darkGround()
        for (filter in listOf(CaptureFilter.Grayscale, CaptureFilter.BlackAndWhite, CaptureFilter.Enhanced, CaptureFilter.Whiteboard)) {
            assertEquals(filter.name, 0x6EDC8C95L, checksum(apply(page, filter)))
        }
    }
}
