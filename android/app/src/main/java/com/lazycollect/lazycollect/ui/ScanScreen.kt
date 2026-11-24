package com.lazycollect.lazycollect.ui

import android.hardware.display.DisplayManager
import android.view.OrientationEventListener
import android.view.Surface
import androidx.activity.compose.BackHandler
import androidx.camera.core.AspectRatio
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import com.lazycollect.lazycollect.R
import com.lazycollect.lazycollect.scan.CaptureFilter
import com.lazycollect.lazycollect.scan.CornerAnswer
import com.lazycollect.lazycollect.scan.ScanCamera
import com.lazycollect.lazycollect.scan.ScanModel
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executor
import kotlin.coroutines.resume
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * The full-screen scanner for one checklist item: a live viewfinder with the page outlined, automatic or manual shots, the pages
 * taken so far and Done, which hands them on. Closing with pages asks whether to discard them. The camera is held only while this
 * screen is composed and the activity is resumed.
 */
@Composable
fun ScanScreen(label: String, scan: ScanModel, onClose: () -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val resumed = lifecycle.lifecycle.currentStateAsState().value.isAtLeast(Lifecycle.State.RESUMED)

    // The three share one aspect ratio, so the preview, the photo and the frames the outline is found in show the same scene.
    val ratio = remember { ResolutionSelector.Builder().setAspectRatioStrategy(AspectRatioStrategy(AspectRatio.RATIO_4_3, AspectRatioStrategy.FALLBACK_RULE_AUTO)).build() }
    val preview = remember { Preview.Builder().setResolutionSelector(ratio).build() }
    val capture = remember { ImageCapture.Builder().setResolutionSelector(ratio).setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).build() }
    val analysis = remember {
        ImageAnalysis.Builder()
            .setResolutionSelector(ratio)
            .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
            .also { it.setAnalyzer(scan.feed.executor, scan.feed) }
    }
    var view by remember { mutableStateOf<PreviewView?>(null) }
    var camera by remember { mutableStateOf<Camera?>(null) }
    var analysing by remember { mutableStateOf(false) }
    var broken by remember { mutableStateOf(false) }
    var torch by rememberSaveable { mutableStateOf(false) }
    var auto by rememberSaveable { mutableStateOf(true) }
    var filter by rememberSaveable { mutableStateOf(CaptureFilter.Enhanced) }
    var focus by remember { mutableStateOf<Offset?>(null) }
    var pagesOpen by rememberSaveable { mutableStateOf(false) }
    var leaving by rememberSaveable { mutableStateOf(false) }

    val running = resumed
    DisposableEffect(running) {
        var provider: ProcessCameraProvider? = null
        var left = false
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            if (left || !running) return@addListener
            val bound = future.get()
            provider = bound
            try {
                try {
                    camera = bound.bindToLifecycle(lifecycle, CameraSelector.DEFAULT_BACK_CAMERA, preview, capture, analysis)
                    analysing = true
                } catch (e: IllegalArgumentException) {
                    // A camera that cannot run all three still takes pages by hand, without the outline.
                    camera = bound.bindToLifecycle(lifecycle, CameraSelector.DEFAULT_BACK_CAMERA, preview, capture)
                }
                camera?.cameraControl?.setZoomRatio(1f)
                broken = false
            } catch (e: Exception) {
                broken = true
            }
        }, ContextCompat.getMainExecutor(context))
        onDispose {
            left = true
            provider?.unbind(preview, capture, analysis)
            camera = null
            analysing = false
        }
    }

    // The shot is tagged for how the phone is held, also when the screen's rotation is locked.
    DisposableEffect(running) {
        val listener = object : OrientationEventListener(context) {
            override fun onOrientationChanged(degrees: Int) {
                if (degrees == ORIENTATION_UNKNOWN) return
                capture.targetRotation = when (degrees) {
                    in 45..134 -> Surface.ROTATION_270
                    in 135..224 -> Surface.ROTATION_180
                    in 225..314 -> Surface.ROTATION_90
                    else -> Surface.ROTATION_0
                }
            }
        }
        if (running && listener.canDetectOrientation()) listener.enable()
        onDispose { listener.disable() }
    }

    // The frames are turned to the screen's rotation, as the preview is, so the outline found in them lands on the page shown.
    val hostView = LocalView.current
    var turned by remember { mutableIntStateOf(0) }
    DisposableEffect(hostView) {
        val displays = context.getSystemService(DisplayManager::class.java)
        val listener = object : DisplayManager.DisplayListener {
            override fun onDisplayChanged(displayId: Int) {
                hostView.display?.let { analysis.targetRotation = it.rotation }
                turned++
            }

            override fun onDisplayAdded(displayId: Int) {}

            override fun onDisplayRemoved(displayId: Int) {}
        }
        hostView.display?.let { analysis.targetRotation = it.rotation }
        displays.registerDisplayListener(listener, null)
        onDispose { displays.unregisterDisplayListener(listener) }
    }
    val frame = {
        turned
        analysis.resolutionInfo?.let { FrameInfo(it.rotationDegrees, it.resolution.width, it.resolution.height) }
    }

    val pages by scan.pages.collectAsState()
    val finishing by scan.finishing.collectAsState()
    val shotEditing by scan.shotEditing.collectAsState()
    val pageEditing by scan.pageEditing.collectAsState()
    val review by scan.review.collectAsState()
    val hasFlash = camera?.cameraInfo?.hasFlashUnit() == true

    SideEffect {
        scan.filter = filter
        scan.auto = auto
    }
    val readyNow by rememberUpdatedState(camera != null)
    DisposableEffect(scan) {
        scan.camera = CaptureCamera(capture, ContextCompat.getMainExecutor(context)) { readyNow }
        onDispose { scan.camera = null }
    }
    val askToReview = review != null && !pagesOpen && shotEditing == null && pageEditing == null
    val covered = pagesOpen || shotEditing != null || pageEditing != null || review != null
    LaunchedEffect(analysing && running, covered) { scan.setLive(analysing && running, covered) }
    DisposableEffect(Unit) { onDispose { scan.setLive(false, false) } }
    // A cut that finishes after the sheet has closed has nowhere to open: the page stays as it was.
    LaunchedEffect(pageEditing, pagesOpen) { pageEditing?.let { if (!pagesOpen) scan.answer(it, CornerAnswer.Cancel) } }
    LaunchedEffect(camera, torch) { camera?.cameraControl?.enableTorch(torch) }

    fun close() {
        if (finishing) return
        if (pages.isEmpty()) onClose() else leaving = true
    }
    BackHandler(onBack = ::close)

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { PreviewView(it).apply { scaleType = PreviewView.ScaleType.FIT_CENTER }.also { made -> view = made; preview.surfaceProvider = made.surfaceProvider } },
        )
        Box(
            Modifier.fillMaxSize()
                .pointerInput(camera) {
                    detectTapGestures { at ->
                        val current = camera ?: return@detectTapGestures
                        val point = view?.meteringPointFactory?.createPoint(at.x, at.y) ?: return@detectTapGestures
                        current.cameraControl.startFocusAndMetering(FocusMeteringAction.Builder(point).build())
                        focus = at
                    }
                }
                .pointerInput(camera) {
                    detectTransformGestures { _, _, zoom, _ ->
                        val current = camera ?: return@detectTransformGestures
                        val state = current.cameraInfo.zoomState.value ?: return@detectTransformGestures
                        current.cameraControl.setZoomRatio((state.zoomRatio * zoom).coerceIn(state.minZoomRatio, state.maxZoomRatio))
                    }
                },
        )
        focus?.let { at ->
            LaunchedEffect(at) {
                delay(1200)
                focus = null
            }
            Box(Modifier.offset { IntOffset((at.x - 36.dp.toPx()).toInt(), (at.y - 36.dp.toPx()).toInt()) }.size(72.dp).border(1.5.dp, Color.White, RoundedCornerShape(4.dp)))
        }
        ScanOutline(scan, frame)

        if (broken) {
            Column(Modifier.align(Alignment.Center), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    stringResource(R.string.client_camera_failed),
                    Modifier.padding(16.dp).background(Color(0xFF2A2A2A), RoundedCornerShape(14.dp)).padding(16.dp),
                    color = Color.White,
                    style = MaterialTheme.typography.titleMedium,
                    textAlign = TextAlign.Center,
                )
            }
        }

        ScanChrome(
            scan = scan,
            label = label,
            cameraReady = camera != null,
            auto = auto,
            onAuto = { auto = it },
            filter = filter,
            onFilter = { filter = it },
            hasTorch = hasFlash,
            torch = torch,
            onTorch = { torch = it },
            onClose = ::close,
            onPages = { pagesOpen = true },
        )
    }

    if (pagesOpen) ScanPagesSheet(scan) { pagesOpen = false }
    shotEditing?.let { request -> CornerEditorDialog(request) { scan.answer(request, it) } }
    pageEditing?.let { request -> CornerEditorDialog(request) { scan.answer(request, it) } }
    review?.takeIf { askToReview }?.let { page ->
        AlertDialog(
            onDismissRequest = {},
            title = { Text(stringResource(R.string.scan_issues_title)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    page.issues.forEach { Text(stringResource(issueText(it))) }
                }
            },
            confirmButton = { TextButton(onClick = { scan.accept(page.id) }) { Text(stringResource(R.string.scan_use_anyway)) } },
            dismissButton = { TextButton(onClick = { scan.delete(page.id) }) { Text(stringResource(R.string.scan_retake)) } },
        )
    }
    if (leaving) {
        AlertDialog(
            onDismissRequest = { leaving = false },
            title = { Text(LocalContext.current.resources.getQuantityString(R.plurals.scan_discard, pages.size, pages.size)) },
            confirmButton = { TextButton(onClick = { scan.discard(); onClose() }) { Text(stringResource(R.string.scan_discard_yes)) } },
            dismissButton = { TextButton(onClick = { leaving = false }) { Text(stringResource(R.string.scan_discard_no)) } },
        )
    }
}

/** Takes a page's photo for the scan model: a JPEG in memory, tagged for how the phone is held, with the flash left to the light. */
private class CaptureCamera(private val capture: ImageCapture, private val executor: Executor, private val isReady: () -> Boolean) : ScanCamera {
    override val ready get() = isReady()

    override suspend fun takePhoto(): ByteArray? = suspendCancellableCoroutine { done ->
        capture.flashMode = ImageCapture.FLASH_MODE_OFF
        val out = ByteArrayOutputStream()
        capture.takePicture(
            ImageCapture.OutputFileOptions.Builder(out).build(),
            executor,
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) = done.resume(out.toByteArray())

                override fun onError(exception: ImageCaptureException) = done.resume(null)
            },
        )
    }
}
