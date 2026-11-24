package com.lazycollect.lazycollect.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.lazycollect.lazycollect.R
import com.lazycollect.lazycollect.net.Me
import com.lazycollect.lazycollect.shell.Action

private const val THIRTY_DAYS = 30 * 86_400_000L

/** A closed account keeps its records for 30 days; the owner can bring it back until then, or for as long as a hold keeps records. */
@Composable
fun ClosedScreen(me: Me, now: Long, action: Action, onReopen: () -> Unit, onSignOut: () -> Unit) {
    val closedAt = me.firm.closedAt ?: 0
    val within = closedAt + THIRTY_DAYS > now
    val date = formatDate(closedAt + THIRTY_DAYS, me.firm.tz)
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
        Column(
            Modifier.safeDrawingPadding().verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.primary)
            Text(stringResource(R.string.closed_title), style = MaterialTheme.typography.titleLarge)
            Text(stringResource(if (within) R.string.closed_body else if (me.firm.held) R.string.closed_body_held else R.string.closed_body_purging, date))
            if (!me.user.owner) Text(stringResource(R.string.closed_member), color = MaterialTheme.colorScheme.onSurfaceVariant)
            ErrorNote(action.error)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (me.user.owner && (within || me.firm.held)) {
                    Button(onClick = onReopen, enabled = !action.busy) { Text(stringResource(R.string.closed_reopen)) }
                }
                OutlinedButton(onClick = onSignOut) { Text(stringResource(R.string.nav_signout)) }
            }
        }
    }
}
