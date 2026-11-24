package com.lazycollect.lazycollect.ui

import androidx.annotation.StringRes
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.lazycollect.lazycollect.R
import com.lazycollect.lazycollect.scan.CaptureFilter
import com.lazycollect.lazycollect.scan.CapturePlacement
import com.lazycollect.lazycollect.scan.CaptureQuality
import com.lazycollect.lazycollect.scan.CaptureState
import com.lazycollect.lazycollect.scan.LiveQuadUpdate
import com.lazycollect.lazycollect.scan.OutlineMapping
import com.lazycollect.lazycollect.scan.PageIssue
import com.lazycollect.lazycollect.scan.PreviewScale
import com.lazycollect.lazycollect.scan.ScanModel
import com.lazycollect.lazycollect.scan.ScanPage
import com.lazycollect.lazycollect.scan.ScanProblem

private val Green = Color(0xFF34C759)
private val Yellow = Color(0xFFFFCC00)
internal val Scrim = Color.Black.copy(alpha = 0.45f)

/** The analysis frame as the camera gives it: its size before any turn, and the clockwise turn that makes it upright. */
class FrameInfo(val rotation: Int, val width: Int, val height: Int)

fun filterName(filter: CaptureFilter): Int = when (filter) {
    CaptureFilter.Enhanced -> R.string.scan_filter_enhanced
    CaptureFilter.Original -> R.string.scan_filter_original
    CaptureFilter.Grayscale -> R.string.scan_filter_grayscale
    CaptureFilter.BlackAndWhite -> R.string.scan_filter_bw
    CaptureFilter.Whiteboard -> R.string.scan_filter_whiteboard
}

@StringRes
fun issueText(issue: PageIssue): Int = when (issue) {
    PageIssue.Blur -> R.string.scan_issue_blur
    PageIssue.Glare -> R.string.scan_issue_glare
    PageIssue.Dark -> R.string.scan_issue_dark
    PageIssue.Cut -> R.string.scan_issue_cut
    PageIssue.Small -> R.string.scan_issue_small
}

@Composable
fun problemText(problem: ScanProblem): String = when (problem) {
    is ScanProblem.Res -> stringResource(problem.id)
    is ScanProblem.Message -> problem.text
}

/** The count of pages as a phrase ("1 page", "3 pages"). */
@Composable
fun pagesText(count: Int): String = LocalContext.current.resources.getQuantityString(R.plurals.scan_pages, count, count)

/**
 * What the page in view is waiting for, as the line over the picture: how it sits in the frame, or why a page that holds still is
 * not taken yet, or that it is about to be. Null when there is nothing to say.
 */
@StringRes
fun scanStatus(update: LiveQuadUpdate, auto: Boolean): Int? {
    val followed = update.outline != null && (update.state == CaptureState.Moving || update.state == CaptureState.Steadying)
    if (followed || update.placement == CapturePlacement.CutOff) {
        when (update.placement) {
            CapturePlacement.Far -> return R.string.scan_closer
            CapturePlacement.CutOff -> return R.string.scan_fit_page
            CapturePlacement.Fine -> {}
        }
    }
    if (auto && update.state == CaptureState.Steadying) {
        return when (update.quality) {
            CaptureQuality.Blurry -> if (update.suggestsShutter) R.string.scan_tap_shutter else R.string.scan_not_sharp
            CaptureQuality.Dark -> R.string.scan_too_dark
            CaptureQuality.Good -> R.string.scan_found
        }
    }
    return null
}

/** The outline of the page found, over the preview: green while it holds still, else yellow. */
@Composable
fun ScanOutline(scan: ScanModel, frame: () -> FrameInfo?) {
    val live by scan.live.collectAsState()
    Canvas(Modifier.fillMaxSize()) {
        val update = live ?: return@Canvas
        val outline = update.outline ?: return@Canvas
        val info = frame() ?: return@Canvas
        val corners = OutlineMapping.toView(outline, info.rotation, info.width, info.height, size.width.toDouble(), size.height.toDouble(), PreviewScale.Fit)
        val path = Path().apply {
            corners.forEachIndexed { i, c -> if (i == 0) moveTo(c.x.toFloat(), c.y.toFloat()) else lineTo(c.x.toFloat(), c.y.toFloat()) }
            close()
        }
        val color = if (update.isSteady) Green else Yellow
        drawPath(path, color.copy(alpha = 0.15f))
        drawPath(path, color, style = Stroke(3.dp.toPx(), join = StrokeJoin.Round))
    }
}

/**
 * The scanner over the picture: Close, Auto and the light, the line that says what the page in view is waiting for, the Look pill
 * with its drawer, and the bottom row with the pages taken, the shutter and Done.
 */
@Composable
fun ScanChrome(
    scan: ScanModel,
    label: String,
    cameraReady: Boolean,
    auto: Boolean,
    onAuto: (Boolean) -> Unit,
    filter: CaptureFilter,
    onFilter: (CaptureFilter) -> Unit,
    hasTorch: Boolean,
    torch: Boolean,
    onTorch: (Boolean) -> Unit,
    onClose: () -> Unit,
    onPages: () -> Unit,
    onShutter: () -> Unit = {},
) {
    val pages by scan.pages.collectAsState()
    val live by scan.live.collectAsState()
    val working by scan.working.collectAsState()
    val finishing by scan.finishing.collectAsState()
    val shotEditing by scan.shotEditing.collectAsState()
    val pageEditing by scan.pageEditing.collectAsState()
    val problem by scan.problem.collectAsState()
    val canShoot = cameraReady && !working && !finishing && shotEditing == null && pageEditing == null
    var drawerOpen by rememberSaveable { mutableStateOf(false) }

    val hint = live?.takeIf { canShoot }?.let { scanStatus(it, auto) }
    val line = when {
        working -> stringResource(R.string.scan_cutting)
        finishing -> stringResource(R.string.scan_preparing)
        hint != null -> stringResource(hint)
        else -> null
    }
    val progress = if (auto && canShoot && live?.state == CaptureState.Steadying) live?.progress?.toFloat() ?: 0f else 0f
    val ring by animateFloatAsState(progress, tween(100, easing = LinearEasing), label = "ring")

    Column(Modifier.fillMaxSize().statusBarsPadding(), horizontalAlignment = Alignment.CenterHorizontally) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(40.dp).clip(CircleShape).background(Scrim).clickable(enabled = !finishing, onClick = onClose), contentAlignment = Alignment.Center) {
                Icon(painterResource(R.drawable.ic_close), stringResource(R.string.scan_close), tint = Color.White)
            }
            AutoChip(auto, onAuto)
            if (hasTorch) TorchButton(torch, onTorch)
            Text(
                stringResource(R.string.scan_title, label),
                Modifier.weight(1f),
                color = Color.White,
                style = MaterialTheme.typography.labelLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        problem?.let { ProblemPill(problemText(it)) }
        line?.let { StatusPill(it) }
        Box(Modifier.weight(1f))
        ControlsHandle(drawerOpen) { drawerOpen = !drawerOpen }
        if (drawerOpen) FilterDrawer(filter, onFilter)
        Row(Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, top = 12.dp, bottom = 20.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                // Not while a shot is being cut out or the editor is up: that answer would open over the sheet.
                PagesStack(scan, pages, enabled = pages.isNotEmpty() && !working && !finishing && shotEditing == null, onClick = onPages)
            }
            Shutter(canShoot, stringResource(R.string.scan_take_page), ring) {
                onShutter()
                scan.shoot()
            }
            Box(Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) {
                if (pages.isNotEmpty()) {
                    Button(onClick = scan::done, enabled = !working && !finishing && shotEditing == null && pageEditing == null) {
                        Text(stringResource(R.string.scan_done, pages.size), maxLines = 1)
                    }
                }
            }
        }
    }
}

@Composable
private fun AutoChip(auto: Boolean, onAuto: (Boolean) -> Unit) {
    val state = stringResource(if (auto) R.string.scan_on else R.string.scan_off)
    val hint = stringResource(R.string.scan_auto_hint)
    Text(
        stringResource(R.string.scan_auto),
        Modifier.clip(RoundedCornerShape(50))
            .background(if (auto) MaterialTheme.colorScheme.primary else Scrim)
            .semantics { stateDescription = "$state. $hint" }
            .selectable(auto, role = Role.Switch) { onAuto(!auto) }
            .heightIn(min = 36.dp)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        color = if (auto) MaterialTheme.colorScheme.onPrimary else Color.White,
        style = MaterialTheme.typography.labelLarge,
        maxLines = 1,
    )
}

@Composable
private fun TorchButton(on: Boolean, onTorch: (Boolean) -> Unit) {
    Box(Modifier.size(40.dp).clip(CircleShape).background(Scrim).clickable { onTorch(!on) }, contentAlignment = Alignment.Center) {
        Icon(
            painterResource(if (on) R.drawable.ic_flash_on else R.drawable.ic_flash_off),
            stringResource(if (on) R.string.scan_light_on else R.string.scan_light_off),
            tint = if (on) Color.Yellow else Color.White,
        )
    }
}

@Composable
private fun StatusPill(text: String) {
    Text(
        text,
        Modifier.padding(horizontal = 12.dp, vertical = 4.dp).background(Color.Black.copy(alpha = 0.75f), RoundedCornerShape(50)).padding(horizontal = 12.dp, vertical = 6.dp),
        color = Color.White,
        style = MaterialTheme.typography.bodyMedium,
    )
}

@Composable
internal fun ProblemPill(text: String) {
    Text(
        text,
        Modifier.padding(8.dp).background(MaterialTheme.colorScheme.error, RoundedCornerShape(50)).padding(horizontal = 12.dp, vertical = 6.dp),
        color = MaterialTheme.colorScheme.onError,
        style = MaterialTheme.typography.bodySmall,
    )
}

/** The pill at the foot of the picture that shows or hides the drawer under it. */
@Composable
private fun ControlsHandle(open: Boolean, onToggle: () -> Unit) {
    val label = stringResource(if (open) R.string.scan_controls_hide else R.string.scan_controls_show)
    Box(Modifier.heightIn(min = 48.dp).clickable(onClickLabel = label, onClick = onToggle), contentAlignment = Alignment.Center) {
        Row(
            Modifier.clip(RoundedCornerShape(50))
                .background(if (open) MaterialTheme.colorScheme.primary else Color(0xFF262626))
                .border(1.dp, Color.White.copy(alpha = 0.3f), RoundedCornerShape(50))
                .padding(start = 14.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val color = if (open) MaterialTheme.colorScheme.onPrimary else Color.White
            Text(stringResource(R.string.scan_controls), color = color, style = MaterialTheme.typography.labelLarge)
            Icon(painterResource(R.drawable.ic_chevron_up), null, Modifier.size(20.dp).rotate(if (open) 180f else 0f), tint = color)
        }
    }
}

/** What the pill opens, over a dark panel: the filter new pages get. */
@Composable
private fun FilterDrawer(filter: CaptureFilter, onFilter: (CaptureFilter) -> Unit) {
    Row(
        Modifier.padding(horizontal = 16.dp).padding(bottom = 8.dp).fillMaxWidth().background(Color.Black.copy(alpha = 0.6f), RoundedCornerShape(14.dp)).horizontalScroll(rememberScrollState()).padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        CaptureFilter.displayOrder.forEach { Choice(filterName(it), it == filter) { onFilter(it) } }
    }
}

@Composable
private fun Choice(@StringRes label: Int, selected: Boolean, onClick: () -> Unit) {
    Text(
        stringResource(label),
        Modifier.clip(RoundedCornerShape(50))
            .background(if (selected) MaterialTheme.colorScheme.primary else Color.White.copy(alpha = 0.2f))
            .selectable(selected, role = Role.RadioButton, onClick = onClick)
            .heightIn(min = 36.dp)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        color = if (selected) MaterialTheme.colorScheme.onPrimary else Color.White,
        style = MaterialTheme.typography.labelLarge,
        maxLines = 1,
    )
}

/** The shutter; [progress] fills a green ring round it, which is Auto's count while a page holds still. */
@Composable
private fun Shutter(enabled: Boolean, label: String, progress: Float = 0f, onClick: () -> Unit) {
    Box(Modifier.size(76.dp).alpha(if (enabled) 1f else 0.4f), contentAlignment = Alignment.Center) {
        Box(Modifier.size(76.dp).border(4.dp, Color.White, CircleShape).padding(7.dp).clip(CircleShape).background(Color.White).semantics { contentDescription = label }.clickable(enabled = enabled, onClick = onClick))
        if (progress > 0f) {
            Canvas(Modifier.size(76.dp)) {
                val width = 4.dp.toPx()
                drawArc(
                    Green, -90f, 360f * progress.coerceAtMost(1f), false,
                    topLeft = Offset(width / 2, width / 2), size = Size(size.width - width, size.height - width),
                    style = Stroke(width, cap = StrokeCap.Round),
                )
            }
        }
    }
}

/** The pages taken: the last on a card, a second card behind it once there are two, and the count on a badge. */
@Composable
private fun PagesStack(scan: ScanModel, pages: List<ScanPage>, enabled: Boolean, onClick: () -> Unit) {
    val count = pages.size
    val last = pages.lastOrNull()
    val thumb = last?.let { remember(it.id, it.jpeg) { scan.thumbnail(it) } }
    val label = pagesText(count)
    val hint = stringResource(R.string.scan_pages_hint)
    Box(
        Modifier.size(width = 70.dp, height = 72.dp)
            .alpha(if (enabled || count == 0) 1f else 0.4f)
            .semantics { contentDescription = "$label. $hint" }
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (thumb != null) {
            if (count > 1) {
                Box(Modifier.offset(x = 3.dp, y = (-2).dp).rotate(6f).size(width = 46.dp, height = 60.dp).background(Color.White.copy(alpha = 0.5f), RoundedCornerShape(6.dp)))
            }
            Box {
                Image(
                    thumb.asImageBitmap(), null,
                    Modifier.background(Color.White, RoundedCornerShape(6.dp)).padding(3.dp).size(width = 46.dp, height = 60.dp).clip(RoundedCornerShape(4.dp)),
                    contentScale = ContentScale.Crop,
                )
                Text(
                    count.toString(),
                    Modifier.align(Alignment.TopEnd).padding(4.dp).background(MaterialTheme.colorScheme.primary, RoundedCornerShape(50)).heightIn(min = 18.dp).padding(horizontal = 5.dp),
                    color = MaterialTheme.colorScheme.onPrimary,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        } else {
            Box(
                Modifier.size(width = 48.dp, height = 64.dp).drawBehind {
                    drawRoundRect(
                        Color.White.copy(alpha = 0.6f), cornerRadius = CornerRadius(6.dp.toPx()),
                        style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 3.dp.toPx()))),
                    )
                },
            )
        }
    }
}
