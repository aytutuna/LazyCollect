package com.lazycollect.lazycollect.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AssistChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.lazycollect.lazycollect.R
import com.lazycollect.lazycollect.net.FirmState
import com.lazycollect.lazycollect.net.Me
import com.lazycollect.lazycollect.shell.DevicesState

/** What the plan section says, and the date it names; the same states as the web's Settings. */
fun planLine(firm: FirmState, now: Long): Pair<Int, Long?> = when {
    firm.planStatus == "active" ->
        (if (firm.cancelAtPeriodEnd) R.string.plan_line_cancelling else R.string.plan_line_active) to (firm.currentPeriodEnd ?: now)
    firm.planStatus == "past_due" ->
        if (firm.usable) R.string.plan_line_past_due to ((firm.pastDueSince ?: 0) + GRACE_MS) else R.string.plan_line_past_due_ended to null
    firm.planStatus == "trialing" && (firm.trialEndsAt ?: 0) > now -> {
        val ends = firm.trialEndsAt!!
        val text = when {
            firm.subscribed && firm.cancelAtPeriodEnd -> R.string.plan_line_trial_cancelling
            firm.subscribed -> R.string.plan_line_trial_subscribed
            // billing starts at once when less than 48 hours of the trial are left
            ends < now + 2 * 86_400_000L -> R.string.plan_line_trial_soon
            else -> R.string.plan_line_trial
        }
        text to ends
    }
    else -> R.string.plan_line_ended to null
}

@Composable
fun SettingsScreen(me: Me, devices: DevicesState, actions: ShellActions, now: Long = System.currentTimeMillis()) {
    LaunchedEffect(Unit) { actions.loadDevices() }
    Column(
        Modifier.verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(stringResource(R.string.settings_title), style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(R.string.settings_account), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
        Text(stringResource(R.string.settings_signed_in, me.user.email))
        OutlinedButton(onClick = actions.signOut) { Text(stringResource(R.string.nav_signout)) }
        HorizontalDivider()
        Text(stringResource(R.string.settings_plan), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
        val (plan, date) = planLine(me.firm, now)
        Text(if (date == null) stringResource(plan) else stringResource(plan, formatDate(date, me.firm.tz)))
        // TODO: the subscribe and manage buttons go here once the plan is sold through Google Play Billing
        HorizontalDivider()
        Text(stringResource(R.string.security_devices), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
        val list = devices.devices
        if (list != null) {
            list.forEach { device ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(device.label ?: stringResource(R.string.security_device_unknown), style = MaterialTheme.typography.titleSmall)
                            if (device.current) AssistChip(onClick = {}, label = { Text(stringResource(R.string.security_this_device)) })
                        }
                        Text(
                            stringResource(R.string.security_device_times, formatDateTime(device.createdAt, me.firm.tz), formatDateTime(device.lastSeenAt, me.firm.tz)),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    val id = device.id
                    if (!device.current && id != null) {
                        TextButton(onClick = { actions.endDevice(id) }, enabled = !devices.busy) { Text(stringResource(R.string.security_signout)) }
                    }
                }
            }
            if (list.size > 1) OutlinedButton(onClick = actions.endOthers, enabled = !devices.busy) { Text(stringResource(R.string.security_signout_others)) }
        } else if (devices.error == null) {
            Text(stringResource(R.string.loading), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        ErrorNote(devices.error)
    }
}
