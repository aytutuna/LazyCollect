package com.lazycollect.lazycollect.scan

import kotlin.math.abs
import kotlin.math.exp

/** One drawn frame of a page on a dark table, its outline, and a stand-in for the corner model that finds it, so the scan can be run without a camera. */
object ScanDemo {
    const val WIDTH = 360
    const val HEIGHT = 480
    private const val COSINE = 0.99619469809174555
    private const val SINE = 0.087155742747658166
    private const val HALF_WIDTH = 130.0
    private const val HALF_HEIGHT = 180.0

    val frame: RgbaImage by lazy { drawn() }

    /** The page in [frame], in its pixels. */
    val outline: Quad = Quad.fromCorners(
        listOf(-1.0 to -1.0, 1.0 to -1.0, 1.0 to 1.0, -1.0 to 1.0).map { (sx, sy) ->
            val u = sx * HALF_WIDTH
            val v = sy * HALF_HEIGHT
            Pt(WIDTH / 2.0 + u * COSINE - v * SINE, HEIGHT / 2.0 + u * SINE + v * COSINE)
        },
    )

    /** The frame as a shot. */
    val photo: ByteArray by lazy { JpegEncoder.encode(frame, false) ?: ByteArray(0) }

    /** What the tracker would say of a page that holds still, for the status line and the shutter's ring. */
    val update = LiveQuadUpdate(
        LiveQuadTracker.normalized(outline, WIDTH, HEIGHT), CaptureState.Steadying, 0.7, 0.0, isSteady = true,
    )

    val camera = object : ScanCamera {
        override val ready = true

        override suspend fun takePhoto(): ByteArray = photo
    }

    /** The model's stand-in: four spots on the page's corners. */
    fun finder(): CornerModel = CornerModel { _ ->
        val side = 64
        val values = FloatArray(side * side * 4)
        for ((channel, corner) in outline.corners.withIndex()) {
            val cx = corner.x / WIDTH * side
            val cy = corner.y / HEIGHT * side
            for (row in 0 until side) {
                for (column in 0 until side) {
                    val dx = column + 0.5 - cx
                    val dy = row + 0.5 - cy
                    values[channel * side * side + row * side + column] = (0.9 * exp(-(dx * dx + dy * dy) / 8)).toFloat()
                }
            }
        }
        CornerHeatmaps(values, side, side)
    }

    private fun sample(px: Double, py: Double): Triple<Int, Int, Int> {
        val dx = px - WIDTH / 2.0
        val dy = py - HEIGHT / 2.0
        val u = dx * COSINE + dy * SINE
        val v = -dx * SINE + dy * COSINE
        if (!(abs(u) < HALF_WIDTH && abs(v) < HALF_HEIGHT)) return Triple(38, 40, 46)
        val top = v + HALF_HEIGHT
        val left = u + HALF_WIDTH
        val inside = left >= 24 && left < 2 * HALF_WIDTH - 24
        if (top >= 14 && top < 30 && inside) return Triple(60, 70, 110)
        if (top >= 44 && top < 330 && inside && (top.toInt() - 44) % 20 < 7) return Triple(70, 70, 78)
        return Triple(238, 236, 230)
    }

    private fun drawn(): RgbaImage {
        val pixels = ByteArray(WIDTH * HEIGHT * 4) { -1 }
        for (y in 0 until HEIGHT) {
            for (x in 0 until WIDTH) {
                var red = 0
                var green = 0
                var blue = 0
                for (k in 0 until 4) {
                    val color = sample(x + 0.25 + 0.5 * (k and 1), y + 0.25 + 0.5 * (k shr 1))
                    red += color.first
                    green += color.second
                    blue += color.third
                }
                val o = (y * WIDTH + x) * 4
                pixels[o] = ((red + 2) / 4).toByte()
                pixels[o + 1] = ((green + 2) / 4).toByte()
                pixels[o + 2] = ((blue + 2) / 4).toByte()
            }
        }
        return RgbaImage(WIDTH, HEIGHT, pixels)
    }
}
