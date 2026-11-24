package com.lazycollect.lazycollect.ui

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.lazycollect.lazycollect.R
import com.lazycollect.lazycollect.net.Me
import com.lazycollect.lazycollect.net.Person
import com.lazycollect.lazycollect.net.RequestDetail
import com.lazycollect.lazycollect.net.RequestFile
import com.lazycollect.lazycollect.net.RequestItem
import com.lazycollect.lazycollect.requests.MAX_REJECT_NOTE
import com.lazycollect.lazycollect.requests.MAX_REPLY
import com.lazycollect.lazycollect.requests.Need
import com.lazycollect.lazycollect.requests.PreviewState
import com.lazycollect.lazycollect.requests.RequestState
import com.lazycollect.lazycollect.requests.reasonsFor
import com.lazycollect.lazycollect.requests.rejectNeed

class RequestActions(
    val reload: () -> Unit = {},
    val approve: (RequestItem) -> Unit = {},
    val reject: (RequestItem, Set<String>, String) -> Unit = { _, _, _ -> },
    val waive: (RequestItem) -> Unit = {},
    val askAgain: (RequestItem, String) -> Unit = { _, _ -> },
    val remind: () -> Unit = {},
    val showLink: () -> Unit = {},
    val makeLink: (Boolean) -> Unit = {},
    val reply: (String) -> Unit = {},
    val preview: (RequestFile) -> Unit = {},
    val closePreview: () -> Unit = {},
    val back: () -> Unit = {},
)

class ItemGroup(val person: Person?, val items: List<RequestItem>)

/** What is for everyone first, then each person's own, as the client sees it. */
fun groupItems(items: List<RequestItem>, people: List<Person>): List<ItemGroup> {
    val general = items.filter { it.personPos == null }
    val each = people.map { p -> ItemGroup(p, items.filter { it.personPos == p.position }) }.filter { it.items.isNotEmpty() }
    return if (general.isNotEmpty()) listOf(ItemGroup(null, general)) + each else each
}

@StringRes
private fun itemStatusName(status: String) = when (status) {
    "submitted" -> R.string.item_status_submitted
    "approved" -> R.string.item_status_approved
    "rejected" -> R.string.item_status_rejected
    "unavailable" -> R.string.item_status_unavailable
    "waived" -> R.string.item_status_waived
    else -> R.string.item_status_empty
}

@StringRes
fun whyName(code: String) = when (code) {
    "blurry" -> R.string.why_blurry
    "cut_off" -> R.string.why_cut_off
    "glare" -> R.string.why_glare
    "dark" -> R.string.why_dark
    "wrong_document" -> R.string.why_wrong_document
    "wrong_period" -> R.string.why_wrong_period
    "expired" -> R.string.why_expired
    "wrong_person" -> R.string.why_wrong_person
    "pages_missing" -> R.string.why_pages_missing
    "locked_pdf" -> R.string.why_locked_pdf
    else -> R.string.why_other
}

@Composable
fun ItemStatusBadge(status: String) {
    val colors = MaterialTheme.colorScheme
    val (container, content) = when (status) {
        "submitted" -> colors.primaryContainer to colors.onPrimaryContainer
        "approved", "waived" -> colors.secondaryContainer to colors.onSecondaryContainer
        "rejected", "unavailable" -> colors.errorContainer to colors.onErrorContainer
        else -> colors.surfaceVariant to colors.onSurfaceVariant
    }
    Badge(stringResource(itemStatusName(status)), container, content)
}

@Composable
fun RequestScreen(state: RequestState, preview: PreviewState, me: Me, planEnded: Boolean, actions: RequestActions, now: Long = System.currentTimeMillis()) {
    val request = state.request
    val tz = me.firm.tz
    when {
        request == null -> Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            TextButton(onClick = actions.back) { Text(stringResource(R.string.req_back)) }
            if (state.loadError != null) {
                ErrorNote(state.loadError, me.user.owner, me.firm.planStatus == "past_due")
                Button(onClick = actions.reload) { Text(stringResource(R.string.retry)) }
            } else {
                Box(Modifier.fillMaxWidth().padding(top = 48.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            }
        }
        else -> Detail(request, state, preview, me, planEnded, actions, now)
    }
}

@Composable
private fun Detail(request: RequestDetail, state: RequestState, preview: PreviewState, me: Me, planEnded: Boolean, actions: RequestActions, now: Long) {
    val tz = me.firm.tz
    val owner = me.user.owner
    val pastDue = me.firm.planStatus == "past_due"
    val groups = groupItems(request.items, request.people)
    val received = request.shown.count { it.received }
    var viewing by rememberSaveable { mutableStateOf<String?>(null) }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            TextButton(onClick = actions.back) { Text(stringResource(R.string.req_back)) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text(request.title, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
                StatusBadge(request.status)
            }
        }
        if (state.stale) item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.req_refresh_failed), color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f))
                TextButton(onClick = actions.reload) { Text(stringResource(R.string.retry)) }
            }
        }
        if (state.error != null) item { ErrorNote(state.error, owner, pastDue) }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Fact(R.string.req_client, state.clientName)
                val late = request.deadline < now && request.editable
                Fact(R.string.req_deadline, relativeDay(request.deadline, now, tz) + ", " + formatDate(request.deadline, tz), late)
                Fact(R.string.req_progress_label, stringResource(R.string.req_progress, received, request.shown.size))
                if (request.sentAt != null) {
                    Fact(
                        R.string.req_opened_label,
                        if (request.firstOpenedAt != null) stringResource(R.string.req_opened, formatDate(request.firstOpenedAt, tz)) else stringResource(R.string.req_not_opened),
                    )
                }
                request.note?.let { Text(it, modifier = Modifier.padding(top = 4.dp)) }
            }
        }
        if (request.editable) item { LinkSection(request, state, planEnded, owner, pastDue, actions) }
        item { Text(stringResource(R.string.req_checklist), style = MaterialTheme.typography.titleLarge) }
        for (group in groups) {
            if (groups.size > 1 || group.person != null) item(key = "g${group.person?.position}") {
                val shown = group.items.filter { !it.hidden }
                Column(Modifier.padding(top = 8.dp)) {
                    Text(group.person?.name ?: stringResource(R.string.req_for_everyone), style = MaterialTheme.typography.titleMedium)
                    if (group.person != null) {
                        Text(
                            stringResource(roleName(group.person.role)) + ", " + stringResource(R.string.req_progress, shown.count { it.received }, shown.size),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            items(group.items.size, key = { group.items[it].id }) { index ->
                ItemCard(group.items[index], request, state, tz, actions) { file -> viewing = file.id }
            }
        }
        item { ThreadSection(request, state, tz, owner, pastDue, actions) }
    }
    val files = request.items.flatMap { item -> item.files.map { item.id to it } }
    val at = files.indexOfFirst { it.second.id == viewing }
    if (viewing != null && at >= 0) {
        ViewerScreen(
            files = files.map { (itemId, file) -> request.items.first { it.id == itemId } to file },
            index = at,
            preview = preview,
            reviewable = request.reviewable,
            busy = state.busy,
            error = state.error,
            actions = actions,
            onMove = { to -> viewing = files[to].second.id },
            onClose = {
                viewing = null
                actions.closePreview()
            },
            owner = owner,
            pastDue = pastDue,
        )
    }
}

@Composable
private fun Fact(@StringRes label: Int, value: String, late: Boolean = false) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(label), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(0.35f))
        Text(value, color = if (late) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(0.65f))
    }
}

@Composable
private fun LinkSection(request: RequestDetail, state: RequestState, planEnded: Boolean, owner: Boolean, pastDue: Boolean, actions: RequestActions) {
    val context = LocalContext.current
    var asking by rememberSaveable { mutableStateOf(false) }
    var email by rememberSaveable { mutableStateOf(false) }
    var copied by rememberSaveable { mutableStateOf(false) }
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.req_link), style = MaterialTheme.typography.titleMedium)
            val url = state.link
            if (url != null) {
                Text(url, style = MaterialTheme.typography.bodyMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { copyLink(context, url); copied = true }) { Text(stringResource(R.string.req_link_copy)) }
                    OutlinedButton(onClick = { shareText(context, url) }) { Text(stringResource(R.string.req_link_share)) }
                }
                if (copied) Text(stringResource(R.string.req_link_copied), color = MaterialTheme.colorScheme.primary)
            } else {
                Text(
                    stringResource(
                        when {
                            state.linkNote == "missing" -> R.string.req_link_missing
                            request.sentAt != null -> R.string.req_link_exists
                            else -> R.string.req_link_none
                        },
                    ),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (request.sentAt != null) OutlinedButton(onClick = actions.showLink, enabled = !state.busy) { Text(stringResource(R.string.req_link_show)) }
            }
            when (state.linkNote) {
                "emailed" -> Text(stringResource(R.string.req_link_emailed))
                "email_failed" -> Text(stringResource(R.string.req_link_email_failed), color = MaterialTheme.colorScheme.error)
            }
            HorizontalDivider()
            if (request.sentAt != null) {
                OutlinedButton(onClick = actions.remind, enabled = !state.busy && request.status == "open") { Text(stringResource(R.string.req_remind)) }
                Text(
                    stringResource(if (request.status == "open") R.string.req_remind_help else R.string.req_remind_closed),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (state.reminded) Text(stringResource(R.string.req_remind_sent), color = MaterialTheme.colorScheme.primary)
                HorizontalDivider()
            }
            Button(onClick = { asking = true }, enabled = !state.busy && !planEnded && request.items.isNotEmpty()) {
                Text(stringResource(if (request.sentAt != null) R.string.req_link_replace else R.string.req_link_create))
            }
            if (planEnded) Text(stringResource(R.string.req_link_paused), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    if (asking) {
        AlertDialog(
            onDismissRequest = { asking = false },
            title = { Text(stringResource(if (request.sentAt != null) R.string.req_link_replace else R.string.req_link_create)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (request.sentAt != null) Text(stringResource(R.string.req_link_replace_warning))
                    Row(Modifier.toggleable(email, role = Role.Checkbox, onValueChange = { email = it }), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = email, onCheckedChange = null)
                        Text(stringResource(R.string.req_link_email), modifier = Modifier.padding(start = 8.dp))
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { asking = false; copied = false; actions.makeLink(email) }) {
                    Text(stringResource(if (request.sentAt != null) R.string.req_link_replace else R.string.req_link_create))
                }
            },
            dismissButton = { TextButton(onClick = { asking = false }) { Text(stringResource(R.string.req_cancel)) } },
        )
    }
}

@Composable
private fun ItemCard(item: RequestItem, request: RequestDetail, state: RequestState, tz: String, actions: RequestActions, onView: (RequestFile) -> Unit) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
                Text(
                    item.label + if (item.required) "" else " (" + stringResource(R.string.req_optional) + ")",
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f).padding(end = 8.dp),
                )
                ItemStatusBadge(item.status)
            }
            item.help?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            if (item.hidden) Text(stringResource(R.string.req_hidden), color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (item.expiryRule != null) ExpiryLines(item)
            if (item.kind != "file") {
                val answer = when (item.answerText) {
                    "" -> null
                    "yes" -> stringResource(R.string.req_yes)
                    "no" -> stringResource(R.string.req_no)
                    else -> item.answerText
                }
                Text(if (answer != null) stringResource(R.string.req_answer, answer) else stringResource(R.string.req_no_answer))
            }
            if (item.status == "rejected") Why(item)
            if (item.status == "unavailable" && request.reviewable) Unavailable(item, state.busy, actions)
            if (item.status == "waived" && item.unavailableNote != null) {
                Text(stringResource(R.string.req_unavailable_reason, item.unavailableNote), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            item.files.forEach { file ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { onView(file) }, modifier = Modifier.weight(1f)) {
                        Text(file.name + " (" + formatSize(file.size) + ")", modifier = Modifier.fillMaxWidth())
                    }
                    if (file.sentBackAt != null) Badge(stringResource(R.string.req_sent_back))
                }
            }
            if (item.status == "submitted" && request.reviewable) ReviewControls(item, state.busy, actions)
        }
    }
}

@Composable
private fun ExpiryLines(item: RequestItem) {
    val given = if (item.expiryRule == "issue") item.issuedOn else item.expiresOn
    Text(
        when {
            given == null -> stringResource(R.string.req_no_date)
            item.expiryRule == "issue" -> stringResource(R.string.req_good_until, formatDay(item.validTo ?: given))
            else -> stringResource(R.string.req_expires, formatDay(given))
        },
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    val colors = MaterialTheme.colorScheme
    when (item.expiryFlag) {
        "expired" -> Badge(stringResource(R.string.req_flag_expired), colors.errorContainer, colors.onErrorContainer)
        "short" -> Badge(stringResource(R.string.req_flag_short), colors.errorContainer, colors.onErrorContainer)
        "soon" -> Badge(stringResource(R.string.req_flag_soon), colors.secondaryContainer, colors.onSecondaryContainer)
    }
}

/** The reasons a document was sent back for, then the note; "other" has no wording of its own, the note says it. */
@Composable
private fun Why(item: RequestItem) {
    val codes = item.rejectReasons.filter { it != "other" }
    if (codes.isNotEmpty()) Text(codes.map { stringResource(whyName(it)) }.joinToString(", "), color = MaterialTheme.colorScheme.error)
    item.rejectNote?.let { Text(it, color = MaterialTheme.colorScheme.error) }
}

@Composable
fun ReviewControls(item: RequestItem, busy: Boolean, actions: RequestActions) {
    var rejecting by rememberSaveable(item.id) { mutableStateOf(false) }
    var reasons by rememberSaveable(item.id) { mutableStateOf(emptyList<String>()) }
    var note by rememberSaveable(item.id) { mutableStateOf("") }
    val file = item.kind == "file"
    val need = rejectNeed(item.kind, reasons.toSet(), note)
    if (!rejecting) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { actions.approve(item) }, enabled = !busy) { Text(stringResource(R.string.req_approve)) }
            OutlinedButton(onClick = { rejecting = true }, enabled = !busy) { Text(stringResource(R.string.req_reject)) }
        }
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.req_reject_reasons), style = MaterialTheme.typography.titleSmall)
        reasonsFor(item.kind).forEach { code ->
            val on = code in reasons
            Row(
                Modifier.fillMaxWidth().toggleable(on, role = Role.Checkbox, onValueChange = { picked ->
                    reasons = reasonsFor(item.kind).filter { if (it == code) picked else it in reasons }
                }),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(checked = on, onCheckedChange = null)
                Text(stringResource(whyName(code)), modifier = Modifier.padding(start = 8.dp))
            }
        }
        Text(stringResource(R.string.req_reject_reasons_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(
            value = note,
            onValueChange = { note = it.take(MAX_REJECT_NOTE) },
            label = { Text(stringResource(R.string.req_reject_note)) },
            supportingText = { Text(stringResource(if (file) R.string.req_reject_hint else R.string.req_reject_hint_question)) },
            minLines = 3,
            modifier = Modifier.fillMaxWidth(),
        )
        if (need != null) {
            Text(
                stringResource(
                    when (need) {
                        Need.OtherNote -> R.string.req_reject_other_note
                        Need.Reason -> R.string.req_reject_need
                        Need.Note -> R.string.req_reject_need_note
                    },
                ),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { actions.reject(item, reasons.toSet(), note) }, enabled = !busy && need == null) { Text(stringResource(R.string.req_reject_send)) }
            OutlinedButton(onClick = { rejecting = false }) { Text(stringResource(R.string.req_cancel)) }
        }
    }
}

@Composable
private fun Unavailable(item: RequestItem, busy: Boolean, actions: RequestActions) {
    var asking by rememberSaveable(item.id) { mutableStateOf(false) }
    var note by rememberSaveable(item.id) { mutableStateOf("") }
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(stringResource(R.string.req_unavailable_title), style = MaterialTheme.typography.titleSmall)
            Text(item.unavailableNote?.let { stringResource(R.string.req_unavailable_reason, it) } ?: stringResource(R.string.req_unavailable_none))
            if (asking) {
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it.take(MAX_REJECT_NOTE) },
                    label = { Text(stringResource(R.string.req_ask_again_note)) },
                    supportingText = { Text(stringResource(R.string.req_ask_again_hint)) },
                    minLines = 3,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { actions.askAgain(item, note) }, enabled = !busy && note.isNotBlank()) { Text(stringResource(R.string.req_ask_again_send)) }
                    OutlinedButton(onClick = { asking = false }) { Text(stringResource(R.string.req_cancel)) }
                }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { actions.waive(item) }, enabled = !busy) { Text(stringResource(R.string.req_waive)) }
                    OutlinedButton(onClick = { asking = true }, enabled = !busy) { Text(stringResource(R.string.req_ask_again)) }
                }
            }
        }
    }
}

@Composable
private fun ThreadSection(request: RequestDetail, state: RequestState, tz: String, owner: Boolean, pastDue: Boolean, actions: RequestActions) {
    var body by rememberSaveable { mutableStateOf("") }
    val thread = state.thread
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.req_thread), style = MaterialTheme.typography.titleLarge)
            if (thread != null && thread.unanswered > 0) {
                val colors = MaterialTheme.colorScheme
                Badge(pluralStringResource(R.plurals.req_thread_unanswered, thread.unanswered, thread.unanswered), colors.secondaryContainer, colors.onSecondaryContainer)
            }
        }
        if (thread != null && thread.notes.isEmpty()) Text(stringResource(R.string.req_thread_none), color = MaterialTheme.colorScheme.onSurfaceVariant)
        thread?.notes?.forEach { note ->
            val mine = note.author != "client"
            Column {
                Text(
                    (if (mine) stringResource(R.string.req_thread_you) else state.clientName) + "  " + formatDateTime(note.createdAt, tz),
                    style = MaterialTheme.typography.labelMedium,
                    color = if (mine) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(note.body)
            }
        }
        if (request.reviewable) {
            OutlinedTextField(
                value = body,
                onValueChange = { body = it.take(MAX_REPLY) },
                label = { Text(stringResource(R.string.req_thread_reply)) },
                supportingText = { Text(stringResource(R.string.req_thread_hint)) },
                minLines = 3,
                modifier = Modifier.fillMaxWidth(),
            )
            Button(onClick = { actions.reply(body) }, enabled = !state.busy && body.isNotBlank()) { Text(stringResource(R.string.req_thread_send)) }
            // the reply is saved whatever happened to the email; once it shows, the box can be emptied
            LaunchedEffect(state.replied) { if (state.replied != null) body = "" }
            state.replied?.let { Text(stringResource(replyResult(it)), color = MaterialTheme.colorScheme.primary) }
        }
    }
}

@StringRes
fun replyResult(email: String) = when (email) {
    "sent" -> R.string.req_thread_email_sent
    "recent" -> R.string.req_thread_email_recent
    "unsubscribed" -> R.string.req_thread_email_unsubscribed
    "no_email" -> R.string.req_thread_email_no_email
    "not_set_up" -> R.string.req_thread_email_not_set_up
    "no_link" -> R.string.req_thread_email_no_link
    "email_limit" -> R.string.req_thread_email_email_limit
    else -> R.string.req_thread_email_failed
}
