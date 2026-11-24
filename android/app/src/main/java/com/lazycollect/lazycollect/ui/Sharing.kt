package com.lazycollect.lazycollect.ui

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.PersistableBundle
import androidx.core.content.FileProvider
import java.io.File

/** Puts a client link on the clipboard, marked so the keyboard and the clipboard preview do not show it. */
fun copyLink(context: Context, url: String) {
    val clip = ClipData.newPlainText("link", url)
    clip.description.extras = PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true) }
    context.getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
}

fun shareText(context: Context, text: String) {
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
    launch(context, Intent.createChooser(send, null))
}

/** Hands a file the client sent to another app through the cache's file provider. */
fun shareFile(context: Context, file: File, mime: String) {
    val send = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uriOf(context, file)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    launch(context, Intent.createChooser(send, null))
}

fun openFile(context: Context, file: File, mime: String) {
    val view = Intent(Intent.ACTION_VIEW).setDataAndType(uriOf(context, file), mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    launch(context, Intent.createChooser(view, null))
}

private fun uriOf(context: Context, file: File) = FileProvider.getUriForFile(context, context.packageName + ".files", file)

private fun launch(context: Context, intent: Intent) {
    try {
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (e: ActivityNotFoundException) {
        // nothing on the phone takes it; the viewer's own message already says the type cannot be shown
    }
}
