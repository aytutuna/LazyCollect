package com.lazycollect.lazycollect.client

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import kotlin.math.max
import kotlin.math.roundToInt

private const val LONG_EDGE = 2400
private const val JPEG_QUALITY = 82
private const val PAGE_LONG_SIDE = 842f

/** A file ready to be queued. [jpeg] marks the ones that may be merged into one PDF. */
class Prepared(val name: String, val file: File, val jpeg: Boolean)

/** The size a picture is scaled to so its long side is at most [limit], never larger than it is. */
fun fitLongEdge(width: Int, height: Int, limit: Int = LONG_EDGE): Pair<Int, Int> {
    val long = max(width, height)
    if (long <= limit) return width to height
    val scale = limit.toDouble() / long
    return max(1, (width * scale).roundToInt()) to max(1, (height * scale).roundToInt())
}

/** A PDF page for a picture: the long side is 842 points, as on the web page. */
fun pageSize(width: Int, height: Int): Pair<Int, Int> {
    val scale = PAGE_LONG_SIDE / max(width, height)
    return max(1, (width * scale).roundToInt()) to max(1, (height * scale).roundToInt())
}

/** Several pictures go as one PDF when it will fit in what the server takes. */
fun shouldCombine(sizes: List<Long>): Boolean = sizes.size > 1 && sizes.sumOf { it + 2048 } <= MAX_UPLOAD

private val PICTURE_OR_PDF = setOf("jpg", "jpeg", "png", "webp", "heic", "heif", "gif", "bmp", "avif", "pdf")

// a label such as "Pay stub no. 1" has a dot that is not an extension
fun withExtension(name: String, ext: String): String {
    val base = if (name.substringAfterLast('.', "").lowercase() in PICTURE_OR_PDF) name.substringBeforeLast('.') else name
    return base.ifBlank { "file" } + ".$ext"
}

// A picture too big for the memory left is a file that cannot be prepared, not a crash; callers already treat IOException that way.
private inline fun <T> fitting(block: () -> T): T = try {
    block()
} catch (e: OutOfMemoryError) {
    throw IOException()
}

class Prepare(private val context: Context) {
    private val dir = File(context.cacheDir, "prepared").apply { mkdirs() }

    /** A picture becomes a JPEG at most 2400 px on its long side; a PDF or anything else is copied as it is. Null when it cannot be read. */
    fun read(uri: Uri, name: String): Prepared? {
        val resolver = context.contentResolver
        val type = resolver.getType(uri).orEmpty()
        val out = File(dir, UUID.randomUUID().toString())
        try {
            if (type.startsWith("image/")) {
                return fitting {
                    val bitmap = decode(uri) ?: return copy(uri, name, out)
                    jpeg(bitmap, withExtension(name, "jpg"), out)
                }
            }
            return copy(uri, name, out)
        } catch (e: Exception) {
            out.delete()
            throw e
        }
    }

    /** The picture flattened onto white and written as a JPEG; the picture is recycled. */
    private fun jpeg(bitmap: Bitmap, name: String, out: File): Prepared {
        try {
            val flat = Bitmap.createBitmap(bitmap.width, bitmap.height, Bitmap.Config.ARGB_8888)
            Canvas(flat).apply {
                drawColor(Color.WHITE)
                drawBitmap(bitmap, 0f, 0f, null)
            }
            FileOutputStream(out).use { flat.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, it) }
            flat.recycle()
            return Prepared(name, out, true)
        } finally {
            bitmap.recycle()
        }
    }

    private fun copy(uri: Uri, name: String, out: File): Prepared? {
        val input = context.contentResolver.openInputStream(uri) ?: return null
        input.use { i -> out.outputStream().use { i.copyTo(it) } }
        return Prepared(name, out, false)
    }

    private fun decode(uri: Uri): Bitmap? {
        val resolver = context.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) } ?: return null
        if (bounds.outWidth <= 0) return null
        var sample = 1
        while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= LONG_EDGE) sample *= 2
        val raw = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) } ?: return null
        val orientation = resolver.openInputStream(uri)?.use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) } ?: ExifInterface.ORIENTATION_NORMAL
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
        }
        val (w, h) = fitLongEdge(raw.width, raw.height)
        matrix.postScale(w.toFloat() / raw.width, h.toFloat() / raw.height)
        val turned = Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, matrix, true)
        if (turned !== raw) raw.recycle()
        return turned
    }

    /** One page per picture. Null when the result is too big for the server, so the pictures go on their own. */
    fun combine(parts: List<Prepared>, name: String): Prepared? {
        val doc = PdfDocument()
        val out = File(dir, UUID.randomUUID().toString())
        try {
            parts.forEachIndexed { index, part ->
                val bitmap = fitting { BitmapFactory.decodeFile(part.file.path) } ?: return null
                val (w, h) = pageSize(bitmap.width, bitmap.height)
                val page = doc.startPage(PdfDocument.PageInfo.Builder(w, h, index + 1).create())
                page.canvas.drawBitmap(bitmap, null, android.graphics.Rect(0, 0, w, h), Paint(Paint.FILTER_BITMAP_FLAG))
                doc.finishPage(page)
                bitmap.recycle()
            }
            FileOutputStream(out).use { doc.writeTo(it) }
            if (out.length() > MAX_UPLOAD) {
                out.delete()
                return null
            }
            return Prepared(withExtension(name, "pdf"), out, false)
        } catch (e: Exception) {
            out.delete()
            throw e
        } finally {
            doc.close()
        }
    }

    /** A scanned page, as a picked photo is: at most 2400 px on its long side, on white. Null when it cannot be read. */
    private fun scannedPage(jpeg: ByteArray, name: String): Prepared? = fitting {
        val raw = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: return@fitting null
        val (w, h) = fitLongEdge(raw.width, raw.height)
        val fitted = if (w == raw.width && h == raw.height) raw else Bitmap.createScaledBitmap(raw, w, h, true).also { raw.recycle() }
        jpeg(fitted, name, File(dir, UUID.randomUUID().toString()))
    }

    /**
     * The pages of a scan as files: "<label> n.jpg" for each page, or "<label>.jpg" for a lone page. Several that fit in what the
     * server takes are merged into one PDF named "<label>.pdf". Empty when a page cannot be read.
     */
    fun scanned(pages: List<ByteArray>, label: String): List<Prepared> {
        val read = ArrayList<Prepared>()
        try {
            for ((index, jpeg) in pages.withIndex()) {
                val made = scannedPage(jpeg, if (pages.size == 1) "$label.jpg" else "$label ${index + 1}.jpg")
                if (made == null) {
                    read.forEach { it.file.delete() }
                    return emptyList()
                }
                read.add(made)
            }
        } catch (e: Exception) {
            read.forEach { it.file.delete() }
            throw e
        }
        if (!shouldCombine(read.map { it.file.length() })) return read
        val pdf = try {
            combine(read, label) ?: return read
        } catch (e: Exception) {
            read.forEach { it.file.delete() }
            throw e
        }
        read.forEach { it.file.delete() }
        return listOf(Prepared("$label.pdf", pdf.file, false))
    }

    /** Pictures chosen together are merged into one PDF named after the item when they fit. */
    fun all(uris: List<Pair<Uri, String>>, label: String): List<Prepared> {
        val read = ArrayList<Prepared>()
        try {
            for ((uri, name) in uris) read(uri, name)?.let(read::add)
        } catch (e: Exception) {
            read.forEach { it.file.delete() }
            throw e
        }
        val jpegs = read.filter { it.jpeg }
        if (!shouldCombine(jpegs.map { it.file.length() })) return read
        val pdf = try {
            combine(jpegs, label) ?: return read
        } catch (e: Exception) {
            read.forEach { it.file.delete() }
            throw e
        }
        jpegs.forEach { it.file.delete() }
        return read.filter { !it.jpeg } + pdf
    }
}
