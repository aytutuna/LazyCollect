package com.lazycollect.lazycollect.ui

import androidx.annotation.StringRes
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.lazycollect.lazycollect.R
import com.lazycollect.lazycollect.net.RequestRow
import com.lazycollect.lazycollect.requests.RequestsState
import com.lazycollect.lazycollect.requests.SORTS
import com.lazycollect.lazycollect.requests.STATUSES
import com.lazycollect.lazycollect.requests.VIEWS
import com.lazycollect.lazycollect.requests.of
import kotlinx.coroutines.delay

class RequestsActions(
    val refresh: () -> Unit = {},
    val show: (String) -> Unit = {},
    val filter: (String?) -> Unit = {},
    val sort: (String) -> Unit = {},
    val search: (String) -> Unit = {},
    val more: () -> Unit = {},
    val open: (String) -> Unit = {},
)

@StringRes
private fun viewName(view: String) = when (view) {
    "to_review" -> R.string.req_view_to_review
    "waiting" -> R.string.req_view_waiting
    "expiring" -> R.string.req_view_expiring
    "overdue" -> R.string.req_view_overdue
    "due_soon" -> R.string.req_view_due_soon
    else -> R.string.req_view_all
}

@StringRes
private fun emptyText(view: String) = when (view) {
    "to_review" -> R.string.req_none_to_review
    "waiting" -> R.string.req_none_waiting
    "expiring" -> R.string.req_none_expiring
    "overdue" -> R.string.req_none_overdue
    else -> R.string.req_none_due_soon
}

@StringRes
private fun sortName(sort: String) = when (sort) {
    "deadline" -> R.string.req_sort_deadline
    "activity" -> R.string.req_sort_activity
    else -> R.string.req_sort_newest
}

@StringRes
fun statusName(status: String) = when (status) {
    "draft" -> R.string.status_draft
    "open" -> R.string.status_open
    "complete" -> R.string.status_complete
    "expired" -> R.string.status_expired
    else -> R.string.status_closed
}

@Composable
fun relativeDay(ms: Long, now: Long, tz: String): String {
    val days = dayDiff(ms, now, tz)
    return when {
        days == 0 -> stringResource(R.string.req_rel_today)
        days == 1 -> stringResource(R.string.req_rel_tomorrow)
        days == -1 -> stringResource(R.string.req_rel_yesterday)
        days > 0 -> pluralStringResource(R.plurals.req_rel_in_days, days, days)
        else -> pluralStringResource(R.plurals.req_rel_overdue_days, -days, -days)
    }
}

@Composable
fun Badge(text: String, container: Color = MaterialTheme.colorScheme.surfaceVariant, content: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    Surface(color = container, contentColor = content, shape = RoundedCornerShape(50)) {
        Text(text, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 10.dp, vertical = 3.dp))
    }
}

@Composable
fun StatusBadge(status: String) {
    val colors = MaterialTheme.colorScheme
    val (container, content) = when (status) {
        "open" -> colors.primaryContainer to colors.onPrimaryContainer
        "complete" -> colors.secondaryContainer to colors.onSecondaryContainer
        "expired" -> colors.errorContainer to colors.onErrorContainer
        else -> colors.surfaceVariant to colors.onSurfaceVariant
    }
    Badge(stringResource(statusName(status)), container, content)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RequestsScreen(state: RequestsState, tz: String, actions: RequestsActions, now: Long = System.currentTimeMillis()) {
    val rows = state.rows
    Column(Modifier.fillMaxSize()) {
        Text(stringResource(R.string.nav_requests), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(start = 16.dp, top = 16.dp, end = 16.dp))
        if (state.firstRun) {
            Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.req_empty_title), style = MaterialTheme.typography.titleMedium)
                Text(stringResource(R.string.req_empty_body), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            return@Column
        }
        Filters(state, actions)
        PullToRefreshBox(isRefreshing = state.loading && rows != null, onRefresh = actions.refresh, modifier = Modifier.weight(1f).fillMaxWidth()) {
            when {
                rows == null && state.error != null -> Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    ErrorNote(state.error)
                    Button(onClick = actions.refresh) { Text(stringResource(R.string.retry)) }
                }
                rows == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                rows.isEmpty() -> Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    ErrorNote(state.error)
                    Text(stringResource(if (state.filtered || state.view == "all") R.string.req_none_match else emptyText(state.view)))
                    if (state.view != "all") OutlinedButton(onClick = { actions.show("all") }) { Text(stringResource(R.string.req_show_all)) }
                }
                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (state.error != null) item { ErrorNote(state.error) }
                    items(rows, key = { it.id }) { RequestCard(it, tz, now) { actions.open(it.id) } }
                    item {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(
                                stringResource(R.string.req_showing, rows.size, state.counts?.of(state.view) ?: rows.size),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            ErrorNote(state.moreError)
                            if (state.next != null) {
                                OutlinedButton(onClick = actions.more, enabled = !state.loadingMore) {
                                    Text(stringResource(if (state.loadingMore) R.string.loading else R.string.req_more))
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Filters(state: RequestsState, actions: RequestsActions) {
    var typed by rememberSaveable { mutableStateOf(state.query) }
    // the server is asked once the typing pauses
    LaunchedEffect(typed) {
        if (typed.trim() != state.query) {
            delay(300)
            actions.search(typed)
        }
    }
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            VIEWS.forEach { view ->
                val count = state.counts?.of(view)
                FilterChip(
                    selected = state.view == view,
                    onClick = { actions.show(view) },
                    label = { Text(stringResource(viewName(view)) + if (count != null) "  $count" else "") },
                )
            }
        }
        OutlinedTextField(
            value = typed,
            onValueChange = { typed = it.take(100) },
            label = { Text(stringResource(R.string.req_search)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Choice(stringResource(R.string.req_status), state.status?.let { stringResource(statusName(it)) } ?: stringResource(R.string.req_all), listOf<String?>(null) + STATUSES, { it?.let { s -> stringResource(statusName(s)) } ?: stringResource(R.string.req_all) }, actions.filter)
            Choice(stringResource(R.string.req_sort), stringResource(sortName(state.sort)), SORTS, { stringResource(sortName(it)) }) { actions.sort(it) }
        }
    }
}

@Composable
private fun <T> Choice(label: String, shown: String, options: List<T>, name: @Composable (T) -> String, onPick: (T) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { open = true }) { Text("$label: $shown") }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { option ->
                DropdownMenuItem(text = { Text(name(option)) }, onClick = { open = false; onPick(option) })
            }
        }
    }
}

@Composable
private fun RequestCard(row: RequestRow, tz: String, now: Long, onOpen: () -> Unit) {
    val late = row.deadline < now && row.open
    Card(Modifier.fillMaxWidth().clickable(onClick = onOpen), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text(row.clientName, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary, modifier = Modifier.weight(1f))
                StatusBadge(row.status)
            }
            Text(row.title, style = MaterialTheme.typography.titleMedium)
            Text(
                relativeDay(row.deadline, now, tz) + ", " + formatDate(row.deadline, tz),
                color = if (late) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
            LinearProgressIndicator(progress = { if (row.total == 0) 0f else row.received / row.total.toFloat() }, modifier = Modifier.fillMaxWidth())
            Text(stringResource(R.string.req_progress, row.received, row.total), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.horizontalScroll(rememberScrollState())) {
                val colors = MaterialTheme.colorScheme
                if (row.submitted > 0) Badge(pluralStringResource(R.plurals.req_to_review_n, row.submitted, row.submitted), colors.primaryContainer, colors.onPrimaryContainer)
                if (row.unavailable > 0) Badge(pluralStringResource(R.plurals.req_unavailable_n, row.unavailable, row.unavailable), colors.secondaryContainer, colors.onSecondaryContainer)
                if (row.unanswered > 0) Badge(pluralStringResource(R.plurals.req_unanswered_n, row.unanswered, row.unanswered), colors.secondaryContainer, colors.onSecondaryContainer)
                if (row.expiring > 0 && row.expiringOn != null) {
                    Badge(pluralStringResource(R.plurals.req_expiring_n, row.expiring, row.expiring, formatDay(row.expiringOn)), colors.secondaryContainer, colors.onSecondaryContainer)
                }
            }
        }
    }
}
