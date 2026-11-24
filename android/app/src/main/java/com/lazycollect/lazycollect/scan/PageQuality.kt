package com.lazycollect.lazycollect.scan

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Whether a page will be hard to read, with the thresholds and arithmetic of the web scanner's checks (web/src/scan/quality.ts),
 * so a page gets the same advice on the phone and in the browser. The page is read at one size, so a threshold means the same on
 * a live frame and on a 3000 px photo.
 */
object PageQuality {
    const val ANALYSIS = 640

    /** Variance of the Laplacian of the sharpest tenth of the page. */
    const val BLUR_BELOW = 60.0

    /** A patch of near-white cells this large (share of the page) is glare; a page that is all white is just bright paper. */
    const val GLARE_FROM = 0.03
    const val GLARE_UNTIL = 0.6
    private const val CLIPPED = 252
    const val DARK_BELOW = 75.0

    /** The page covers less than this share of the frame: too far away. */
    const val SMALL_BELOW = 0.3
    private const val EDGE_MARGIN = 0.012
    const val CUT_CONFIDENCE = 0.6

    /** Problems with the flat page itself: blur, glare, too dark. */
    fun pageIssues(page: RgbaImage): List<PageIssue> {
        val reduced = reduce(page)
        val issues = ArrayList<PageIssue>()
        val sharp = sharpness(reduced.y, reduced.w, reduced.h)
        if (sharp != null && sharp < BLUR_BELOW) issues.add(PageIssue.Blur)
        val glare = glareShare(reduced.clipped, reduced.w, reduced.h)
        if (glare >= GLARE_FROM && glare <= GLARE_UNTIL) issues.add(PageIssue.Glare)
        if (meanLuminance(reduced.y) < DARK_BELOW) issues.add(PageIssue.Dark)
        return issues
    }

    /**
     * Problems with where the page sits in a frame of `width` x `height`: a corner at or past the frame's edge (or, when the model
     * gave a confidence, a weak one) means a cut-off page; a small share of the frame means it is too far away.
     */
    fun frameIssues(quad: Quad, confidence: Double?, width: Int, height: Int): List<PageIssue> {
        val issues = ArrayList<PageIssue>()
        val mx = width * EDGE_MARGIN
        val my = height * EDGE_MARGIN
        val touching = quad.corners.any { it.x <= mx || it.y <= my || it.x >= width - mx || it.y >= height - my }
        if (touching || (confidence != null && confidence < CUT_CONFIDENCE)) issues.add(PageIssue.Cut)
        if (quad.area / (width.toDouble() * height) < SMALL_BELOW) issues.add(PageIssue.Small)
        return issues
    }

    internal class Reduced(val w: Int, val h: Int, val y: FloatArray, val clipped: ByteArray)

    /** The page averaged down (never up) to at most `ANALYSIS` pixels on its long side, as luminance. */
    internal fun reduce(page: RgbaImage): Reduced {
        val k = max(1.0, max(page.width, page.height).toDouble() / ANALYSIS)
        val w = floor(page.width / k).toInt()
        val h = floor(page.height / k).toInt()
        val y = FloatArray(w * h)
        val clipped = ByteArray(w * h)
        val d = page.pixels
        for (j in 0 until h) {
            val y0 = floor(j * k).toInt()
            val y1 = max(y0 + 1, min(page.height, floor((j + 1) * k).toInt()))
            for (i in 0 until w) {
                val x0 = floor(i * k).toInt()
                val x1 = max(x0 + 1, min(page.width, floor((i + 1) * k).toInt()))
                var r = 0.0
                var g = 0.0
                var b = 0.0
                for (yy in y0 until y1) {
                    for (xx in x0 until x1) {
                        val o = (yy * page.width + xx) * 4
                        r += d[o].toInt() and 0xFF
                        g += d[o + 1].toInt() and 0xFF
                        b += d[o + 2].toInt() and 0xFF
                    }
                }
                val n = ((y1 - y0) * (x1 - x0)).toDouble()
                y[j * w + i] = ((0.299 * r + 0.587 * g + 0.114 * b) / n).toFloat()
                clipped[j * w + i] = if (min(r, min(g, b)) / n >= CLIPPED) 1 else 0
            }
        }
        return Reduced(w, h, y, clipped)
    }

    /** The sharpest tenth of 8 x 8 tiles by variance of the Laplacian; a page with nothing on it gives null. */
    internal fun sharpness(y: FloatArray, w: Int, h: Int): Double? {
        val lap = FloatArray(w * h)
        for (j in 1 until h - 1) {
            for (i in 1 until w - 1) {
                val o = j * w + i
                lap[o] = (y[o - 1].toDouble() + y[o + 1] + y[o - w] + y[o + w] - 4.0 * y[o]).toFloat()
            }
        }
        val tiles = 8
        val scores = ArrayList<Double>()
        var lo = 255.0
        var hi = 0.0
        for (ty in 0 until tiles) {
            for (tx in 0 until tiles) {
                val x0 = max(floor(tx.toDouble() * w / tiles).toInt(), 1)
                val x1 = min(floor((tx + 1).toDouble() * w / tiles).toInt(), w - 1)
                val y0 = max(floor(ty.toDouble() * h / tiles).toInt(), 1)
                val y1 = min(floor((ty + 1).toDouble() * h / tiles).toInt(), h - 1)
                var sum = 0.0
                var sq = 0.0
                var n = 0
                for (j in y0 until y1) {
                    for (i in x0 until x1) {
                        val v = lap[j * w + i].toDouble()
                        sum += v
                        sq += v * v
                        n++
                        lo = min(lo, y[j * w + i].toDouble())
                        hi = max(hi, y[j * w + i].toDouble())
                    }
                }
                if (n > 0) scores.add(sq / n - (sum / n) * (sum / n))
            }
        }
        if (hi - lo < 40 || scores.isEmpty()) return null
        scores.sort()
        return scores[min(scores.size - 1, floor(scores.size * 0.9).toInt())]
    }

    /** The largest share of the page a 4-connected patch of clipped 8 x 8 cells covers. */
    internal fun glareShare(clipped: ByteArray, w: Int, h: Int): Double {
        val cell = 8
        val cw = w / cell
        val ch = h / cell
        if (cw == 0 || ch == 0) return 0.0
        val on = ByteArray(cw * ch)
        for (j in 0 until ch) {
            for (i in 0 until cw) {
                var n = 0
                for (dy in 0 until cell) for (dx in 0 until cell) n += clipped[(j * cell + dy) * w + i * cell + dx]
                on[j * cw + i] = if (n >= cell * cell * 0.9) 1 else 0
            }
        }
        var best = 0
        val stack = ArrayDeque<Int>()
        for (s in on.indices) {
            if (on[s].toInt() != 1) continue
            on[s] = 2
            stack.addLast(s)
            var count = 0
            while (stack.isNotEmpty()) {
                val at = stack.removeLast()
                count++
                val x = at % cw
                val y = (at - x) / cw
                for (next in intArrayOf(if (x > 0) at - 1 else -1, if (x < cw - 1) at + 1 else -1, if (y > 0) at - cw else -1, if (y < ch - 1) at + cw else -1)) {
                    if (next >= 0 && on[next].toInt() == 1) {
                        on[next] = 2
                        stack.addLast(next)
                    }
                }
            }
            best = max(best, count)
        }
        return best.toDouble() / (cw * ch)
    }

    internal fun meanLuminance(y: FloatArray): Double {
        var sum = 0.0
        for (v in y) sum += v
        return sum / y.size
    }
}
