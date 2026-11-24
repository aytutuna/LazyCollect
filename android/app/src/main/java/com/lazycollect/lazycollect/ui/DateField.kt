package com.lazycollect.lazycollect.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.lazycollect.lazycollect.R
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

private val YEARS = 1900..2100

/** The picker works in milliseconds at midnight UTC; this is that moment for a saved day, or null when the day is not valid. */
fun dayToMillis(day: String): Long? =
    if (validDay(day)) LocalDate.parse(day).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() else null

/** The day a picker's milliseconds fall on, as yyyy-MM-dd; null outside 1900 to 2100. */
fun millisToDay(millis: Long): String? =
    Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate().takeIf { it.year in YEARS }?.toString()

/** A day shown as a button that opens a calendar. [onPick] gets yyyy-MM-dd, or null when the person clears it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DateField(label: String, day: String, enabled: Boolean, supporting: String?, onPick: (String?) -> Unit) {
    var open by rememberSaveable { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(enabled = enabled, onClick = { open = true }) { Text(day.ifEmpty { stringResource(R.string.client_choose_date) }) }
            if (day.isNotEmpty()) TextButton(enabled = enabled, onClick = { onPick(null) }) { Text(stringResource(R.string.client_clear_date)) }
        }
        if (supporting != null) Text(supporting, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    if (!open) return
    val state = rememberDatePickerState(initialSelectedDateMillis = dayToMillis(day), yearRange = YEARS)
    DatePickerDialog(
        onDismissRequest = { open = false },
        confirmButton = {
            TextButton(
                enabled = state.selectedDateMillis?.let { millisToDay(it) } != null,
                onClick = {
                    open = false
                    state.selectedDateMillis?.let(::millisToDay)?.let(onPick)
                },
            ) { Text(stringResource(R.string.client_save)) }
        },
        dismissButton = { TextButton(onClick = { open = false }) { Text(stringResource(R.string.client_cancel)) } },
    ) { DatePicker(state) }
}
