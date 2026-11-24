package com.lazycollect.lazycollect.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The cases of the "quality" tests in web/src/scan/scan.test.ts, on the same synthetic pages.
class PageQualityTest {
    private fun byte(v: Double) = Math.rint(v).coerceIn(0.0, 255.0).toInt().toByte()

    // fixtures.ts textPage: short dark strokes in lines on white, from the same linear generator
    private fun textPage(width: Int, height: Int, seed: Long = 7): RgbaImage {
        var s = seed
        fun rnd(): Double {
            s = (s * 1664525 + 1013904223) and 0xFFFFFFFFL
            return s / 4294967296.0
        }
        val data = ByteArray(width * height * 4) { -1 }
        var y = 80
        while (y < height - 80) {
            var x = 80
            while (x < width - 120) {
                val w = 8 + Math.floor(rnd() * 8).toInt()
                fun mark(x0: Int, y0: Int, mw: Int, mh: Int) {
                    for (j in 0 until mh) for (i in 0 until mw) {
                        val o = ((y + y0 + j) * width + x + x0 + i) * 4
                        data[o] = 30
                        data[o + 1] = 30
                        data[o + 2] = 30
                    }
                }
                mark(0, 0, 2, 16)
                mark(w - 2, 0, 2, 16)
                mark(0, if (rnd() < 0.5) 0 else 7, w, 2)
                x += w + 4 + Math.floor(rnd() * 6).toInt()
            }
            y += 34
        }
        return RgbaImage(width, height, data)
    }

    private fun mapped(image: RgbaImage, f: (Int, Int, Int) -> Double): RgbaImage {
        val out = ByteArray(image.pixels.size)
        for (i in out.indices step 4) {
            val p = i / 4
            for (c in 0 until 3) out[i + c] = byte(f(image.pixels[i + c].toInt() and 0xFF, p % image.width, p / image.width))
            out[i + 3] = -1
        }
        return RgbaImage(image.width, image.height, out)
    }

    private fun boxBlur(image: RgbaImage, r: Int): RgbaImage {
        var from = image.pixels
        for (horizontal in listOf(true, false)) {
            val to = ByteArray(from.size)
            for (y in 0 until image.height) for (x in 0 until image.width) {
                var sum = 0
                for (d in -r..r) {
                    val xx = if (horizontal) (x + d).coerceIn(0, image.width - 1) else x
                    val yy = if (horizontal) y else (y + d).coerceIn(0, image.height - 1)
                    sum += from[(yy * image.width + xx) * 4].toInt() and 0xFF
                }
                val o = (y * image.width + x) * 4
                val v = byte(sum.toDouble() / (2 * r + 1))
                to[o] = v
                to[o + 1] = v
                to[o + 2] = v
                to[o + 3] = -1
            }
            from = to
        }
        return RgbaImage(image.width, image.height, from)
    }

    // paper as a photo has it: a little under full white
    private val page = mapped(textPage(1000, 1400)) { v, _, _ -> if (v == 255) 215.0 else v.toDouble() }

    private fun quad(vararg xy: Double) = Quad(Pt(xy[0], xy[1]), Pt(xy[2], xy[3]), Pt(xy[4], xy[5]), Pt(xy[6], xy[7]))

    @Test
    fun aSharpBrightPagePasses() {
        assertEquals(emptyList<PageIssue>(), PageQuality.pageIssues(page))
    }

    @Test
    fun blurIsFlaggedButNotASlightSoftness() {
        assertFalse(PageIssue.Blur in PageQuality.pageIssues(boxBlur(page, 1)))
        assertTrue(PageIssue.Blur in PageQuality.pageIssues(boxBlur(page, 12)))
    }

    @Test
    fun anEmptyPageIsNotBlurry() {
        val blank = RgbaImage.filled(800, 1000, 250, 250, 250)
        val reduced = PageQuality.reduce(blank)
        assertNull(PageQuality.sharpness(reduced.y, reduced.w, reduced.h))
        assertEquals(emptyList<PageIssue>(), PageQuality.pageIssues(blank))
    }

    @Test
    fun aBlownOutPatchIsGlare() {
        val glared = mapped(page) { v, x, y -> if (x in 300 until 700 && y in 300 until 700) 255.0 else v.toDouble() }
        assertTrue(PageIssue.Glare in PageQuality.pageIssues(glared))
    }

    @Test
    fun aDarkPageIsFlagged() {
        assertTrue(PageIssue.Dark in PageQuality.pageIssues(mapped(page) { v, _, _ -> v * 0.25 }))
    }

    @Test
    fun aPageThatTouchesTheFrameOrFillsLittleOfItIsFlagged() {
        assertEquals(emptyList<PageIssue>(), PageQuality.frameIssues(quad(100.0, 100.0, 700.0, 100.0, 700.0, 500.0, 100.0, 500.0), 0.9, 800, 600))
        assertEquals(listOf(PageIssue.Cut), PageQuality.frameIssues(quad(0.0, 100.0, 700.0, 100.0, 700.0, 500.0, 0.0, 500.0), 0.9, 800, 600))
        assertEquals(listOf(PageIssue.Cut), PageQuality.frameIssues(quad(100.0, 100.0, 700.0, 100.0, 700.0, 500.0, 100.0, 500.0), 0.55, 800, 600))
        assertEquals(listOf(PageIssue.Small), PageQuality.frameIssues(quad(300.0, 200.0, 500.0, 200.0, 500.0, 400.0, 300.0, 400.0), null, 800, 600))
    }
}
