package com.lazycollect.lazycollect.ui

import android.net.Uri
import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.lazycollect.lazycollect.R
import com.lazycollect.lazycollect.client.ClientState
import com.lazycollect.lazycollect.client.Job
import com.lazycollect.lazycollect.net.ClientItem
import com.lazycollect.lazycollect.net.ClientView
import com.lazycollect.lazycollect.net.Person
import com.lazycollect.lazycollect.shell.Action
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

class ClientActions(
    val reload: () -> Unit = {},
    val leave: () -> Unit = {},
    val answer: (String, JsonElement?) -> Unit = { _, _ -> },
    val dates: (String, String?, String?, Boolean, Boolean) -> Unit = { _, _, _, _, _ -> },
    val unavailable: (String, String) -> Unit = { _, _ -> },
    val found: (String) -> Unit = {},
    val sendNote: (String) -> Unit = {},
    val removeFile: (String) -> Unit = {},
    val pick: (item: ClientItem, uris: List<Uri>) -> Unit = { _, _ -> },
    val camera: (item: ClientItem, done: (Uri?) -> Unit) -> Unit = { _, _ -> },
    val retryJob: (String) -> Unit = {},
    val dropJob: (String) -> Unit = {},
)

@Composable
fun ClientRoot(state: ClientState, action: Action, jobs: List<Job>, dropped: Int, actions: ClientActions) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
        when (state) {
            ClientState.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            ClientState.Gone -> Column(Modifier.safeDrawingPadding().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text(stringResource(R.string.client_gone_title), style = MaterialTheme.typography.headlineSmall)
                Text(stringResource(R.string.client_gone))
                Button(onClick = actions.leave) { Text(stringResource(R.string.client_gone_done)) }
            }
            is ClientState.Failed -> Column(Modifier.safeDrawingPadding().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                ErrorNote(state.code)
                Button(onClick = actions.reload) { Text(stringResource(R.string.retry)) }
                OutlinedButton(onClick = actions.leave) { Text(stringResource(R.string.client_leave)) }
            }
            is ClientState.Ready -> Checklist(state.view, state.stale, action, jobs, dropped, actions)
        }
    }
}

private fun scopeOf(items: List<ClientItem>) = items.filter { it.required }.ifEmpty { items }

@Composable
private fun Checklist(view: ClientView, stale: Boolean, action: Action, jobs: List<Job>, dropped: Int, actions: ClientActions) {
    val scope = scopeOf(view.items)
    val received = scope.count { it.received }
    val unavailable = scope.count { it.status == "unavailable" }
    val finished = scope.isNotEmpty() && received + unavailable == scope.size
    val groups = groupByPerson(view.items, view.people)
    LazyColumn(Modifier.fillMaxSize().safeDrawingPadding(), contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text(view.firmName, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            Text(view.title, style = MaterialTheme.typography.headlineSmall)
            view.note?.let { Text(it) }
            Text(stringResource(R.string.client_due, formatDate(view.deadline, view.tz)), color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(stringResource(R.string.client_privacy, view.firmName), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (stale) item { Notice(stringResource(R.string.client_refresh_failed), stringResource(R.string.retry), actions.reload) }
        if (action.error != null) item { ErrorNote(action.error) }
        if (dropped > 0) item { Notice(stringResource(R.string.client_items_gone), null, {}) }
        items(jobs, key = { it.id }) { JobRow(it, actions) }
        item {
            Text(stringResource(R.string.client_progress, received, scope.size), style = MaterialTheme.typography.titleMedium)
            if (unavailable > 0) Text(stringResource(R.string.client_progress_na, unavailable), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (finished) item {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(stringResource(R.string.client_all_done_title), style = MaterialTheme.typography.titleMedium)
                    Text(stringResource(R.string.client_all_done_body, view.firmName))
                }
            }
        }
        item { Text(stringResource(R.string.client_checklist), style = MaterialTheme.typography.titleLarge) }
        for (group in groups) {
            if (groups.size > 1 || group.person != null) item(key = "g${group.person?.position}") { GroupHeader(group.person, group.items) }
            val (required, optional) = group.items.partition { it.required }
            items(required, key = { it.id }) { ItemCard(it, view, action.busy, actions) }
            if (optional.isNotEmpty() && required.isNotEmpty()) item { Text(stringResource(R.string.client_optional), style = MaterialTheme.typography.titleSmall) }
            items(optional, key = { it.id }) { ItemCard(it, view, action.busy, actions) }
        }
        item { Notes(view, action.busy, actions) }
        item { Trust(view) }
        item { OutlinedButton(onClick = actions.leave, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.client_leave)) } }
    }
}

/** A request with people lists what is for everyone first, then each person's own. */
fun groupByPerson(items: List<ClientItem>, people: List<Person>): List<Group> {
    val general = items.filter { it.personPos == null }
    val each = people.map { Group(it, items.filter { i -> i.personPos == it.position }) }.filter { it.items.isNotEmpty() }
    return if (general.isNotEmpty()) listOf(Group(null, general)) + each else each
}

class Group(val person: Person?, val items: List<ClientItem>)

@StringRes
private fun roleName(role: String) = when (role) {
    "principal" -> R.string.role_principal
    "spouse" -> R.string.role_spouse
    "child" -> R.string.role_child
    else -> R.string.role_other
}

@Composable
private fun GroupHeader(person: Person?, items: List<ClientItem>) {
    val scope = scopeOf(items)
    Column(Modifier.padding(top = 8.dp)) {
        Text(person?.name ?: stringResource(R.string.client_for_everyone), style = MaterialTheme.typography.titleMedium)
        if (person != null) {
            Text(
                stringResource(roleName(person.role)) + ", " + stringResource(R.string.client_person_progress, scope.count { it.received }, scope.size),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun Notice(text: String, button: String?, onClick: () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(text, Modifier.weight(1f))
            if (button != null) TextButton(onClick = onClick) { Text(button) }
        }
    }
}

@Composable
private fun JobRow(job: Job, actions: ClientActions) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (job.failed == null) CircularProgressIndicator(Modifier.padding(end = 4.dp), strokeWidth = 2.dp)
            Column(Modifier.weight(1f)) {
                Text(stringResource(if (job.failed == null) R.string.client_job_waiting else R.string.client_job_failed, job.name))
                job.failed?.let { ErrorNote(it) }
            }
            if (job.failed != null) TextButton(onClick = { actions.retryJob(job.id) }) { Text(stringResource(R.string.client_try_now)) }
            TextButton(onClick = { actions.dropJob(job.id) }) { Text(stringResource(R.string.client_remove)) }
        }
    }
}

@Composable
private fun badge(status: String): Pair<String, Int> = when (status) {
    "submitted" -> "✓ " to R.string.client_badge_submitted
    "approved" -> "✓ " to R.string.client_badge_approved
    "rejected" -> "! " to R.string.client_badge_rejected
    "unavailable" -> "– " to R.string.client_badge_unavailable
    "waived" -> "✓ " to R.string.client_badge_waived
    else -> "○ " to R.string.client_badge_empty
}

@Composable
private fun ItemCard(item: ClientItem, view: ClientView, busy: Boolean, actions: ClientActions) {
    val (mark, word) = badge(item.status)
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(item.label, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                Text(mark + stringResource(word), style = MaterialTheme.typography.labelLarge)
            }
            item.help?.takeIf { it.isNotBlank() }?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            if (item.status == "rejected") Rejected(item, actions)
            else if (item.status == "submitted" && !item.rejectNote.isNullOrBlank()) Text(stringResource(R.string.client_earlier_note, item.rejectNote), color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (item.kind == "file") FileBody(item, view, busy, actions) else Question(item, busy, actions)
        }
    }
}

@Composable
private fun fixText(code: String, question: Boolean): String? = when (code) {
    "blurry" -> R.string.reason_blurry
    "cut_off" -> R.string.reason_cut_off
    "glare" -> R.string.reason_glare
    "dark" -> R.string.reason_dark
    "wrong_document" -> R.string.reason_wrong_document
    "wrong_period" -> if (question) R.string.reason_wrong_period_question else R.string.reason_wrong_period
    "expired" -> R.string.reason_expired
    "wrong_person" -> if (question) R.string.reason_wrong_person_question else R.string.reason_wrong_person
    "pages_missing" -> R.string.reason_pages_missing
    "locked_pdf" -> R.string.reason_locked_pdf
    else -> null
}?.let { stringResource(it) }

@Composable
private fun Rejected(item: ClientItem, actions: ClientActions) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stringResource(if (item.kind == "file") R.string.client_rejected_title else R.string.client_rejected_question), style = MaterialTheme.typography.titleSmall)
            item.rejectReasons.forEach { code -> fixText(code, item.kind != "file")?.let { Text(it) } }
            item.rejectNote?.takeIf { it.isNotBlank() }?.let { Text(it) }
            if (item.kind != "file" && item.answer != null) TextButton(onClick = { actions.answer(item.id, item.answer) }) { Text(stringResource(R.string.client_keep_answer)) }
        }
    }
}

@Composable
private fun FileBody(item: ClientItem, view: ClientView, busy: Boolean, actions: ClientActions) {
    val firm = view.firmName
    Text(
        when (item.status) {
            "approved" -> stringResource(R.string.client_status_approved, firm)
            "rejected" -> stringResource(R.string.client_status_rejected)
            "unavailable" -> stringResource(R.string.client_status_unavailable, firm)
            "waived" -> stringResource(R.string.client_status_waived, firm)
            else -> if (item.files.isEmpty()) stringResource(R.string.client_status_empty) else pluralStringResource(R.plurals.client_status_files, item.files.size, item.files.size)
        },
        style = MaterialTheme.typography.bodySmall,
    )
    item.files.forEach { file ->
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(file.name, style = MaterialTheme.typography.bodyMedium)
                Text(
                    sizeText(file.size) + if (file.sentBackAt != null) ", " + stringResource(R.string.client_sent_back) else "",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (!item.approved) TextButton(enabled = !busy, onClick = { actions.removeFile(file.id) }) { Text(stringResource(R.string.client_remove)) }
        }
    }
    if (item.approved) return
    if (item.status == "unavailable") {
        item.unavailableNote?.takeIf { it.isNotBlank() }?.let { Text(stringResource(R.string.client_unavailable_reason, it)) }
        OutlinedButton(enabled = !busy, onClick = { actions.found(item.id) }) { Text(stringResource(R.string.client_found_it)) }
        return
    }
    Dates(item, busy, actions)
    Adders(item, busy, actions)
    if (item.status == "empty" || item.status == "rejected") DontHave(item, busy, actions)
}

@Composable
private fun Adders(item: ClientItem, busy: Boolean, actions: ClientActions) {
    val files = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) actions.pick(item, uris)
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(enabled = !busy, onClick = { actions.camera(item) { uri -> if (uri != null) actions.pick(item, listOf(uri)) } }) { Text(stringResource(R.string.client_take_photo)) }
        OutlinedButton(enabled = !busy, onClick = { files.launch(arrayOf("image/*", "application/pdf")) }) { Text(stringResource(R.string.client_choose_file)) }
    }
}

@Composable
private fun DontHave(item: ClientItem, busy: Boolean, actions: ClientActions) {
    var open by rememberSaveable(item.id) { mutableStateOf(false) }
    var note by rememberSaveable(item.id) { mutableStateOf("") }
    if (!open) {
        TextButton(onClick = { open = true }) { Text(stringResource(R.string.client_dont_have)) }
        return
    }
    Text(stringResource(R.string.client_dont_have_title), style = MaterialTheme.typography.titleSmall)
    OutlinedTextField(
        value = note,
        onValueChange = { note = it.take(500) },
        label = { Text(stringResource(R.string.client_dont_have_reason)) },
        supportingText = { Text(stringResource(R.string.client_dont_have_hint)) },
        modifier = Modifier.fillMaxWidth(),
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(enabled = !busy, onClick = { actions.unavailable(item.id, note); open = false }) { Text(stringResource(R.string.client_save)) }
        TextButton(onClick = { open = false }) { Text(stringResource(R.string.client_cancel)) }
    }
}

private val DAY = Regex("^\\d{4}-\\d{2}-\\d{2}$")

fun validDay(text: String): Boolean = DAY.matches(text) && text.take(4).toInt() in 1900..2100 && runCatching { java.time.LocalDate.parse(text) }.isSuccess

@Composable
private fun Dates(item: ClientItem, busy: Boolean, actions: ClientActions) {
    val rule = item.expiryRule ?: return
    val expiry = rule == "expiry"
    val saved = (if (expiry) item.expiresOn else item.issuedOn).orEmpty()
    var text by rememberSaveable(item.id, saved) { mutableStateOf(saved) }
    var bad by rememberSaveable(item.id) { mutableStateOf(false) }
    OutlinedTextField(
        value = text,
        onValueChange = { text = it.take(10); bad = false },
        enabled = !busy,
        singleLine = true,
        label = { Text(stringResource(if (expiry) R.string.client_expires_on else R.string.client_issued_on)) },
        isError = bad,
        supportingText = {
            Text(
                when {
                    bad -> stringResource(R.string.client_date_invalid)
                    !expiry && item.validMonths != null -> stringResource(R.string.client_valid_months, item.validMonths) + " " + stringResource(R.string.client_date_hint)
                    else -> stringResource(R.string.client_date_hint)
                },
            )
        },
        modifier = Modifier.fillMaxWidth().onFocusChanged {
            if (!it.isFocused && text != saved) {
                if (text.isEmpty() || validDay(text)) actions.dates(item.id, text.ifEmpty { null }, text.ifEmpty { null }, expiry, !expiry) else bad = true
            }
        },
    )
}

private val NUMBER = Regex("^-?\\d{1,15}(\\.\\d{1,6}|,\\d{1,2})?$")

/** The number as it is saved, with a dot for the decimal comma; null when it is not a number the server takes. */
fun numberAnswer(text: String): String? = text.trim().takeIf { NUMBER.matches(it) }?.replace(',', '.')

@Composable
private fun Question(item: ClientItem, busy: Boolean, actions: ClientActions) {
    val locked = busy || item.approved
    when (item.kind) {
        "yesno" -> Choices(item, listOf("yes" to stringResource(R.string.client_yes), "no" to stringResource(R.string.client_no)), locked, actions)
        "choice" -> Choices(item, item.options.orEmpty().map { it to it }, locked, actions)
        "multi" -> {
            val chosen = item.answerList
            item.options.orEmpty().forEach { option ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(
                        checked = option in chosen,
                        enabled = !locked,
                        onCheckedChange = { on ->
                            val next = item.options.orEmpty().filter { (it in chosen && it != option) || (on && it == option) }
                            actions.answer(item.id, if (next.isEmpty()) null else JsonArray(next.map(::JsonPrimitive)))
                        },
                    )
                    Text(option)
                }
            }
        }
        else -> TypedAnswer(item, locked, actions)
    }
}

@Composable
private fun Choices(item: ClientItem, options: List<Pair<String, String>>, locked: Boolean, actions: ClientActions) {
    val chosen = item.answerText
    options.forEach { (value, label) ->
        Row(
            Modifier.fillMaxWidth().selectable(selected = chosen == value, enabled = !locked, role = Role.RadioButton, onClick = { actions.answer(item.id, JsonPrimitive(value)) }),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RadioButton(selected = chosen == value, onClick = null, enabled = !locked)
            Text(label, Modifier.padding(start = 8.dp))
        }
    }
}

@Composable
private fun TypedAnswer(item: ClientItem, locked: Boolean, actions: ClientActions) {
    val saved = item.answerText
    var text by rememberSaveable(item.id, saved) { mutableStateOf(saved) }
    var bad by rememberSaveable(item.id) { mutableStateOf(false) }
    if (locked && item.approved) {
        Text(saved)
        return
    }
    OutlinedTextField(
        value = text,
        onValueChange = { text = it.take(if (item.kind == "longtext") 5000 else 500); bad = false },
        enabled = !locked,
        singleLine = item.kind != "longtext",
        label = { Text(stringResource(R.string.client_answer_text)) },
        isError = bad,
        supportingText = {
            when {
                bad && item.kind == "number" -> Text(stringResource(R.string.client_number_invalid))
                bad -> Text(stringResource(R.string.client_date_invalid))
                item.kind == "date" -> Text(stringResource(R.string.client_date_hint))
            }
        },
        modifier = Modifier.fillMaxWidth().onFocusChanged {
            if (it.isFocused || text == saved) return@onFocusChanged
            val value = text.trim()
            when {
                value.isEmpty() -> actions.answer(item.id, null)
                item.kind == "number" -> numberAnswer(value)?.let { n -> actions.answer(item.id, JsonPrimitive(n)) } ?: run { bad = true }
                item.kind == "date" -> if (validDay(value)) actions.answer(item.id, JsonPrimitive(value)) else bad = true
                else -> actions.answer(item.id, JsonPrimitive(value))
            }
        },
    )
}

@Composable
private fun Notes(view: ClientView, busy: Boolean, actions: ClientActions) {
    var text by rememberSaveable { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        HorizontalDivider()
        Text(stringResource(R.string.client_notes_title, view.firmName), style = MaterialTheme.typography.titleMedium)
        Text(stringResource(R.string.client_notes_intro, view.firmName), color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (view.notes.isEmpty()) Text(stringResource(R.string.client_notes_none))
        view.notes.forEach { note ->
            Column {
                Text(
                    (if (note.author == "client") stringResource(R.string.client_notes_you) else view.firmName) + ", " + formatDateTime(note.createdAt, view.tz),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(note.body)
            }
        }
        OutlinedTextField(value = text, onValueChange = { text = it.take(2000) }, label = { Text(stringResource(R.string.client_notes_label)) }, modifier = Modifier.fillMaxWidth())
        Button(enabled = !busy && text.isNotBlank(), onClick = { actions.sendNote(text); text = "" }) { Text(stringResource(R.string.client_notes_send)) }
    }
}

@Composable
private fun Trust(view: ClientView) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        HorizontalDivider()
        view.contact?.let { c ->
            Text(stringResource(R.string.client_contact_title), style = MaterialTheme.typography.titleSmall)
            listOfNotNull(c.name, c.email, c.phone, c.address).filter { it.isNotBlank() }.forEach { Text(it) }
        }
        Text(stringResource(R.string.client_trust_title), style = MaterialTheme.typography.titleSmall)
        Text(stringResource(R.string.client_trust_private))
        Text(stringResource(R.string.client_trust_encrypted))
        Text(stringResource(R.string.client_trust_access, view.firmName))
        Text(stringResource(R.string.client_trust_expires, formatDate(view.expiresAt, view.tz)))
    }
}

private fun sizeText(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "${bytes / 1024} KB"
    else -> "%.1f MB".format(java.util.Locale.CANADA, bytes / 1048576.0)
}
