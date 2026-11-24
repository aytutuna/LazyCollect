package com.lazycollect.lazycollect.client

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.util.Xml
import androidx.core.graphics.PathParser
import java.io.InputStream
import org.xmlpull.v1.XmlPullParser

private val BUILTIN = setOf("passport", "t4", "bank-statement", "void-cheque", "noa")
private val HEX_ID = Regex("^[0-9a-f]{32}$")

sealed interface ExampleRef {
    /** One of the drawings the app carries, named as on the web page. */
    data class Builtin(val name: String) : ExampleRef

    /** A picture the professional uploaded; the server hands it out. */
    data object Uploaded : ExampleRef
}

fun exampleRef(example: String?): ExampleRef? = when {
    example == null -> null
    example in BUILTIN -> ExampleRef.Builtin(example)
    HEX_ID.matches(example) -> ExampleRef.Uploaded
    else -> null
}

/** What a shape is painted with after the groups around it have been applied. */
class Look(
    val fill: Int? = 0xFF000000.toInt(),
    val fillAlpha: Float = 1f,
    val stroke: Int? = null,
    val strokeWidth: Float = 1f,
    val dash: List<Float> = emptyList(),
    val fontSize: Float = 16f,
    val bold: Boolean = false,
    val anchor: String = "start",
    val spacing: Float = 0f,
)

class Turn(val degrees: Float, val x: Float, val y: Float)

sealed interface Shape {
    val look: Look
    val turn: Turn?

    class Rect(val x: Float, val y: Float, val w: Float, val h: Float, val r: Float, override val look: Look, override val turn: Turn?) : Shape

    class Circle(val x: Float, val y: Float, val r: Float, override val look: Look, override val turn: Turn?) : Shape

    class Path(val data: String, override val look: Look, override val turn: Turn?) : Shape

    class Text(val x: Float, val y: Float, val text: String, override val look: Look, override val turn: Turn?) : Shape
}

class ExampleDrawing(val width: Float, val height: Float, val shapes: List<Shape>)

private fun color(text: String): Int? {
    if (text == "none") return null
    return (0xFF000000L or text.removePrefix("#").toLong(16)).toInt()
}

private fun XmlPullParser.attr(name: String): String? = getAttributeValue(null, name)

private fun Look.over(p: XmlPullParser) = Look(
    fill = p.attr("fill")?.let(::color) ?: if (p.attr("fill") == null) fill else null,
    fillAlpha = p.attr("fill-opacity")?.toFloat() ?: fillAlpha,
    stroke = p.attr("stroke")?.let(::color) ?: if (p.attr("stroke") == null) stroke else null,
    strokeWidth = p.attr("stroke-width")?.toFloat() ?: strokeWidth,
    dash = p.attr("stroke-dasharray")?.split(' ')?.map { it.toFloat() } ?: dash,
    fontSize = p.attr("font-size")?.toFloat() ?: fontSize,
    bold = p.attr("font-weight")?.let { it == "700" || it == "bold" } ?: bold,
    anchor = p.attr("text-anchor") ?: anchor,
    spacing = p.attr("letter-spacing")?.toFloat() ?: spacing,
)

private val ROTATE = Regex("^rotate\\(\\s*(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\s*\\)$")

private fun turnOf(text: String?): Turn? {
    val m = ROTATE.matchEntire(text?.trim() ?: return null) ?: return null
    return Turn(m.groupValues[1].toFloat(), m.groupValues[2].toFloat(), m.groupValues[3].toFloat())
}

/**
 * Reads the few SVG elements the example drawings use (rect, circle, path, text, and g for shared paint) so they can be drawn
 * without an SVG library.
 */
fun parseExample(input: InputStream): ExampleDrawing {
    val p = Xml.newPullParser()
    p.setInput(input, null)
    val looks = ArrayDeque<Look>().apply { addLast(Look()) }
    val shapes = mutableListOf<Shape>()
    var width = 0f
    var height = 0f
    while (p.next() != XmlPullParser.END_DOCUMENT) {
        if (p.eventType == XmlPullParser.END_TAG) {
            if (p.name == "g") looks.removeLast()
            continue
        }
        if (p.eventType != XmlPullParser.START_TAG) continue
        val own = looks.last().over(p)
        val num = { name: String -> p.attr(name)?.toFloat() ?: 0f }
        when (p.name) {
            "svg" -> {
                val box = p.attr("viewBox")!!.split(' ').map { it.toFloat() }
                width = box[2]
                height = box[3]
                looks.addLast(own)
            }
            "g" -> looks.addLast(own)
            "rect" -> shapes += Shape.Rect(num("x"), num("y"), num("width"), num("height"), num("rx"), own, turnOf(p.attr("transform")))
            "circle" -> shapes += Shape.Circle(num("cx"), num("cy"), num("r"), own, turnOf(p.attr("transform")))
            "path" -> shapes += Shape.Path(p.attr("d")!!, own, turnOf(p.attr("transform")))
            "text" -> {
                val x = num("x")
                val y = num("y")
                val turn = turnOf(p.attr("transform"))
                shapes += Shape.Text(x, y, p.nextText(), own, turn)
            }
        }
    }
    return ExampleDrawing(width, height, shapes)
}

/** The drawing as a bitmap [pixels] wide. */
fun renderExample(drawing: ExampleDrawing, pixels: Int): Bitmap {
    val scale = pixels / drawing.width
    val bitmap = Bitmap.createBitmap(pixels, Math.round(drawing.height * scale), Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    canvas.scale(scale, scale)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    for (shape in drawing.shapes) {
        canvas.save()
        shape.turn?.let { canvas.rotate(it.degrees, it.x, it.y) }
        val look = shape.look
        if (shape is Shape.Text) {
            paint.reset()
            paint.isAntiAlias = true
            paint.style = Paint.Style.FILL
            paint.typeface = Typeface.create(Typeface.SANS_SERIF, if (look.bold) Typeface.BOLD else Typeface.NORMAL)
            paint.textSize = look.fontSize
            paint.letterSpacing = look.spacing / look.fontSize
            paint.textAlign = when (look.anchor) {
                "middle" -> Paint.Align.CENTER
                "end" -> Paint.Align.RIGHT
                else -> Paint.Align.LEFT
            }
            look.fill?.let {
                paint.color = it
                paint.alpha = Math.round(look.fillAlpha * 255)
                canvas.drawText(shape.text, shape.x, shape.y, paint)
            }
            canvas.restore()
            continue
        }
        val path = (shape as? Shape.Path)?.let { PathParser.createPathFromPathData(it.data) }
        val pass = { stroke: Boolean ->
            paint.reset()
            paint.isAntiAlias = true
            if (stroke) {
                paint.style = Paint.Style.STROKE
                paint.strokeWidth = look.strokeWidth
                paint.color = look.stroke!!
                if (look.dash.size >= 2) paint.pathEffect = DashPathEffect(look.dash.toFloatArray(), 0f)
            } else {
                paint.style = Paint.Style.FILL
                paint.color = look.fill!!
                paint.alpha = Math.round(look.fillAlpha * 255)
            }
            when (shape) {
                is Shape.Rect -> canvas.drawRoundRect(RectF(shape.x, shape.y, shape.x + shape.w, shape.y + shape.h), shape.r, shape.r, paint)
                is Shape.Circle -> canvas.drawCircle(shape.x, shape.y, shape.r, paint)
                is Shape.Path -> canvas.drawPath(path!!, paint)
                is Shape.Text -> Unit
            }
        }
        if (look.fill != null) pass(false)
        if (look.stroke != null) pass(true)
        canvas.restore()
    }
    return bitmap
}

/** A picture the server sent, decoded no larger than [limit] on its long side. Null when it is not a picture. */
fun decodeExample(bytes: ByteArray, limit: Int = 1600): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0) return null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= limit) sample *= 2
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
}
