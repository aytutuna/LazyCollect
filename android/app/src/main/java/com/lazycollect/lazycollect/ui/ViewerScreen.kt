package com.lazycollect.lazycollect.ui

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.lazycollect.lazycollect.R
import com.lazycollect.lazycollect.net.RequestFile
import com.lazycollect.lazycollect.net.RequestItem
import com.lazycollect.lazycollect.requests.PdfPages
import com.lazycollect.lazycollect.requests.PreviewState
import com.lazycollect.lazycollect.requests.Shown
import java.io.File

/** Steps through every file of the request, with the review of the item a file belongs to underneath. */
@Composable
fun ViewerScreen(
    files: List<Pair<RequestItem, RequestFile>>,
    index: Int,
    preview: PreviewState,
    reviewable: Boolean,
    busy: Boolean,
    error: String?,
    actions: RequestActions,
    onMove: (Int) -> Unit,
    onClose: () -> Unit,
    owner: Boolean,
    pastDue: Boolean,
) {
    val (item, file) = files[index]
    val context = LocalContext.current
    // a viewer restored after the screen was recreated has nothing loaded yet
    LaunchedEffect(file.id) { if (preview.file?.id != file.id) actions.preview(file) }
    // after a decision the next document waiting for one comes up, as on the web
    var seen by remember(item.id) { mutableStateOf(item.status) }
    LaunchedEffect(item.status) {
        if (seen == "submitted" && item.status != "submitted") {
            files.indices.firstOrNull { it > index && files[it].first.id != item.id && files[it].first.status == "submitted" }?.let(onMove)
        }
        seen = item.status
    }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
            Column(Modifier.safeDrawingPadding()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = onClose) { Text(stringResource(R.string.viewer_close)) }
                    Text(stringResource(R.string.viewer_file_of, index + 1, files.size), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                    ItemStatusBadge(item.status)
                }
                Column(Modifier.padding(horizontal = 16.dp)) {
                    Text(item.label, style = MaterialTheme.typography.titleSmall)
                    Text(file.name + " (" + formatSize(file.size) + ")", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Box(Modifier.weight(1f).fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                    val shown = preview.shown
                    when {
                        preview.file?.id != file.id || preview.loading -> {
                            CircularProgressIndicator()
                        }
                        preview.error != null -> Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            ErrorNote(preview.error, owner, pastDue)
                            Text(stringResource(R.string.viewer_failed))
                            OutlinedButton(onClick = { actions.preview(file) }) { Text(stringResource(R.string.retry)) }
                        }
                        shown is Shown.Image -> ZoomableImage(shown.bitmap, file.name)
                        shown is Shown.Pdf -> PdfView(shown.file)
                        shown is Shown.Other -> Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(stringResource(R.string.viewer_unsupported))
                        }
                    }
                }
                Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { onMove(index - 1) }, enabled = index > 0) { Text(stringResource(R.string.viewer_previous)) }
                    TextButton(onClick = { onMove(index + 1) }, enabled = index < files.size - 1) { Text(stringResource(R.string.viewer_next)) }
                    val kept = (preview.shown as? Shown.Image)?.file ?: (preview.shown as? Shown.Pdf)?.file ?: (preview.shown as? Shown.Other)?.file
                    if (kept != null && preview.file?.id == file.id) {
                        TextButton(onClick = { shareFile(context, kept, file.mime) }) { Text(stringResource(R.string.viewer_share)) }
                        if (preview.shown is Shown.Other) TextButton(onClick = { openFile(context, kept, file.mime) }) { Text(stringResource(R.string.viewer_open_with)) }
                    }
                }
                Column(Modifier.heightIn(max = 320.dp).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (error != null) ErrorNote(error, owner, pastDue)
                    if (item.status == "submitted" && reviewable) ReviewControls(item, busy, actions)
                }
            }
        }
    }
}

@Composable
private fun ZoomableImage(bitmap: Bitmap, name: String) {
    var scale by remember(bitmap) { mutableFloatStateOf(1f) }
    var offset by remember(bitmap) { mutableStateOf(Offset.Zero) }
    Image(
        bitmap.asImageBitmap(),
        contentDescription = name,
        contentScale = ContentScale.Fit,
        modifier = Modifier
            .fillMaxSize()
            .pointerInput(bitmap) {
                detectTransformGestures { _, pan, zoom, _ ->
                    scale = (scale * zoom).coerceIn(1f, 5f)
                    offset = if (scale == 1f) Offset.Zero else offset + pan
                }
            }
            .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y),
    )
}

@Composable
private fun PdfView(file: File) {
    val pages = remember(file) { runCatching { PdfPages(file) }.getOrNull() }
    DisposableEffect(pages) { onDispose { pages?.close() } }
    if (pages == null) {
        Text(stringResource(R.string.viewer_failed), modifier = Modifier.padding(16.dp))
        return
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val width = with(LocalDensity.current) { maxWidth.roundToPx() }
        LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(pages.count) { page ->
                // a page scrolled out of view is let go, so a long PDF never holds more than a few bitmaps
                val bitmap by produceState<Bitmap?>(null, pages, page, width) { value = runCatching { pages.render(page, width) }.getOrNull() }
                val drawn = bitmap
                if (drawn != null) {
                    Image(drawn.asImageBitmap(), contentDescription = stringResource(R.string.viewer_page, page + 1, pages.count), modifier = Modifier.fillMaxWidth().aspectRatio(drawn.width / drawn.height.toFloat()))
                } else {
                    Box(Modifier.fillMaxWidth().aspectRatio(0.77f), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                }
            }
        }
    }
}
