package com.lazycollect.lazycollect.requests

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import com.lazycollect.lazycollect.net.Api
import com.lazycollect.lazycollect.net.ApiError
import com.lazycollect.lazycollect.net.RequestFile
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

private const val MAX_EDGE = 2048
private const val MAX_PAGE_PIXELS = 4_000_000

enum class Shows { Image, Pdf, Other }

fun showsOf(mime: String) = when (mime) {
    "image/jpeg", "image/png", "image/webp" -> Shows.Image
    "application/pdf" -> Shows.Pdf
    else -> Shows.Other
}

/** The power of two to shrink a picture by so its long edge is still at least [max]. */
fun sampleSize(width: Int, height: Int, max: Int = MAX_EDGE): Int {
    var size = 1
    var long = maxOf(width, height)
    while (long / 2 >= max) {
        size *= 2
        long /= 2
    }
    return size
}

/** A name that is safe as a file name here and still ends in what the client called it. */
fun safeName(name: String): String = name.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").trim().take(100).ifEmpty { "file" }

sealed interface Shown {
    data class Image(val bitmap: Bitmap, val file: File) : Shown

    data class Pdf(val file: File) : Shown

    /** A type the app cannot draw; the file is there to hand to another app. */
    data class Other(val file: File) : Shown
}

data class PreviewState(val file: RequestFile? = null, val shown: Shown? = null, val error: String? = null) {
    val loading get() = file != null && shown == null && error == null
}

/**
 * Fetches a file the client sent and gets it ready to look at. The bytes go to [dir] (in the cache, so the system may drop them)
 * and stay only while the viewer is open.
 */
class PreviewModel(private val scope: CoroutineScope, private val api: Api, private val dir: File, private val io: CoroutineDispatcher = Dispatchers.IO) {
    private val flow = MutableStateFlow(PreviewState())
    private var job: Job? = null

    val state: StateFlow<PreviewState> get() = flow

    fun show(file: RequestFile) {
        job?.cancel()
        flow.value = PreviewState(file)
        job = scope.launch {
            flow.value = try {
                PreviewState(file, open(file))
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                PreviewState(file, error = e.code)
            } catch (e: IOException) {
                PreviewState(file, error = "server_error")
            }
        }
    }

    private suspend fun open(file: RequestFile): Shown = withContext(io) {
        val bytes = api.fileBytes(file.id)
        val saved = File(File(dir, file.id), safeName(file.name))
        saved.parentFile!!.mkdirs()
        saved.writeBytes(bytes)
        when (showsOf(file.mime)) {
            Shows.Image -> decode(bytes)?.let { Shown.Image(it, saved) } ?: Shown.Other(saved)
            Shows.Pdf -> Shown.Pdf(saved)
            Shows.Other -> Shown.Other(saved)
        }
    }

    private fun decode(bytes: ByteArray): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0) return null
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight) })
    }

    /** Drops what was fetched; the viewer is closed. */
    fun close() {
        job?.cancel()
        flow.value = PreviewState()
        dir.deleteRecursively()
    }
}

/**
 * Lets one draw at a time use something that must be released afterwards. [close] never waits: closing from the main thread
 * while a draw is running would block the draw's own resume, so the draw releases when it ends.
 */
internal class DrawGate(private val release: () -> Unit) {
    private val lock = Mutex()
    private val state = Any()
    private var closed = false
    private var drawing = false

    suspend fun <T> draw(block: () -> T): T = lock.withLock {
        withContext(Dispatchers.IO) {
            synchronized(state) {
                if (closed) throw IOException("closed")
                drawing = true
            }
            try {
                block()
            } finally {
                synchronized(state) {
                    drawing = false
                    if (closed) release()
                }
            }
        }
    }

    fun close() {
        synchronized(state) {
            if (closed) return
            closed = true
            if (!drawing) release()
        }
    }
}

/** A PDF drawn a page at a time. The renderer holds one page open at once, so the pages are drawn one after another. */
class PdfPages(file: File) : AutoCloseable {
    private val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    private val renderer = PdfRenderer(descriptor)
    private val gate = DrawGate {
        renderer.close()
        descriptor.close()
    }

    val count: Int = renderer.pageCount

    /** Page [index] as wide as [width] pixels, or smaller when it would take too much memory. */
    suspend fun render(index: Int, width: Int): Bitmap = gate.draw {
        renderer.openPage(index).use { page ->
            var w = width.coerceIn(1, MAX_EDGE)
            var h = (w.toLong() * page.height / page.width).toInt().coerceAtLeast(1)
            if (w.toLong() * h > MAX_PAGE_PIXELS) {
                val scale = Math.sqrt(MAX_PAGE_PIXELS.toDouble() / (w.toLong() * h))
                w = (w * scale).toInt().coerceAtLeast(1)
                h = (h * scale).toInt().coerceAtLeast(1)
            }
            val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(android.graphics.Color.WHITE)
            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            bitmap
        }
    }

    override fun close() = gate.close()
}
