package com.lazycollect.lazycollect.ui

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.lazycollect.lazycollect.R
import com.lazycollect.lazycollect.net.FirmUpdate
import com.lazycollect.lazycollect.shell.FirmState

private val ZONES = listOf(
    "America/St_Johns" to R.string.tz_st_johns,
    "America/Halifax" to R.string.tz_halifax,
    "America/Toronto" to R.string.tz_toronto,
    "America/Winnipeg" to R.string.tz_winnipeg,
    "America/Regina" to R.string.tz_regina,
    "America/Edmonton" to R.string.tz_edmonton,
    "America/Vancouver" to R.string.tz_vancouver,
)

private val PROVINCES = listOf(
    "AB" to R.string.province_ab,
    "BC" to R.string.province_bc,
    "MB" to R.string.province_mb,
    "NB" to R.string.province_nb,
    "NL" to R.string.province_nl,
    "NS" to R.string.province_ns,
    "NT" to R.string.province_nt,
    "NU" to R.string.province_nu,
    "ON" to R.string.province_on,
    "PE" to R.string.province_pe,
    "QC" to R.string.province_qc,
    "SK" to R.string.province_sk,
    "YT" to R.string.province_yt,
)

/** The first run: the name clients will see, with the business details tucked away. */
@Composable
fun SetupScreen(state: FirmState, canEdit: Boolean, onSave: (FirmUpdate) -> Unit, onRetry: () -> Unit, onSignOut: () -> Unit) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
        Column(
            Modifier.safeDrawingPadding().verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.primary)
            Text(stringResource(R.string.setup_title), style = MaterialTheme.typography.titleLarge)
            Text(stringResource(R.string.setup_intro), color = MaterialTheme.colorScheme.onSurfaceVariant)
            val firm = state.firm
            if (firm != null) {
                var name by rememberSaveable { mutableStateOf(firm.name.orEmpty()) }
                var legal by rememberSaveable { mutableStateOf(firm.legalName.orEmpty()) }
                var address by rememberSaveable { mutableStateOf(firm.address.orEmpty()) }
                var phone by rememberSaveable { mutableStateOf(firm.phone.orEmpty()) }
                var province by rememberSaveable { mutableStateOf(firm.province.orEmpty()) }
                var tz by rememberSaveable { mutableStateOf(firm.tz) }
                var business by rememberSaveable { mutableStateOf(listOf(firm.legalName, firm.address, firm.phone, firm.province).any { !it.isNullOrEmpty() }) }
                if (!canEdit) Text(stringResource(R.string.firm_owner_only), color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it.take(120) },
                    label = { Text(stringResource(R.string.firm_name)) },
                    supportingText = { Text(stringResource(R.string.firm_name_hint)) },
                    singleLine = true,
                    enabled = canEdit,
                    modifier = Modifier.fillMaxWidth(),
                )
                TextButton(onClick = { business = !business }) { Text(stringResource(R.string.firm_business)) }
                if (business) {
                    OutlinedTextField(
                        value = legal,
                        onValueChange = { legal = it.take(160) },
                        label = { Text(stringResource(R.string.firm_legal)) },
                        supportingText = { Text(stringResource(R.string.firm_legal_hint)) },
                        singleLine = true,
                        enabled = canEdit,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = address,
                        onValueChange = { address = it.take(300) },
                        label = { Text(stringResource(R.string.firm_address)) },
                        minLines = 3,
                        enabled = canEdit,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = phone,
                        onValueChange = { phone = it.take(40) },
                        label = { Text(stringResource(R.string.firm_phone)) },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                        enabled = canEdit,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Picker(R.string.firm_province, province, listOf("" to stringResource(R.string.firm_province_none)) + PROVINCES.map { it.first to stringResource(it.second) }, canEdit) { province = it }
                }
                val zones = (if (ZONES.any { it.first == firm.tz }) ZONES.map { it.first to stringResource(it.second) } else listOf(firm.tz to firm.tz) + ZONES.map { it.first to stringResource(it.second) })
                Picker(R.string.firm_tz, tz, zones, canEdit) { tz = it }
                Text(stringResource(R.string.firm_tz_hint), color = MaterialTheme.colorScheme.onSurfaceVariant)
                ErrorNote(state.error)
                if (canEdit) {
                    Button(onClick = { onSave(FirmUpdate(name.trim(), legal, address, phone, province, tz)) }, enabled = !state.busy && name.isNotBlank()) {
                        Text(stringResource(R.string.firm_save))
                    }
                }
            } else if (state.error != null) {
                ErrorNote(state.error)
                OutlinedButton(onClick = onRetry) { Text(stringResource(R.string.retry)) }
            } else {
                Text(stringResource(R.string.loading), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            TextButton(onClick = onSignOut) { Text(stringResource(R.string.nav_signout)) }
        }
    }
}

@Composable
private fun Picker(@StringRes label: Int, value: String, options: List<Pair<String, String>>, enabled: Boolean, onPick: (String) -> Unit) {
    var open by rememberSaveable { mutableStateOf(false) }
    Column {
        Text(stringResource(label), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Box {
            OutlinedButton(onClick = { open = true }, enabled = enabled, modifier = Modifier.fillMaxWidth()) {
                Text(options.firstOrNull { it.first == value }?.second ?: value)
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                options.forEach { (code, text) ->
                    DropdownMenuItem(text = { Text(text) }, onClick = {
                        onPick(code)
                        open = false
                    })
                }
            }
        }
    }
}
