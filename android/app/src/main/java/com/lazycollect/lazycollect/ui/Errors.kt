package com.lazycollect.lazycollect.ui

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.lazycollect.lazycollect.R

/** The words for a server error code; the plan texts depend on who is asking and on whether a payment failed. */
@StringRes
fun errorText(code: String, owner: Boolean = true, pastDue: Boolean = false): Int = when (code) {
    "network" -> R.string.error_network
    "rate_limited" -> R.string.error_rate_limited
    "too_many" -> R.string.error_too_many
    "invalid" -> R.string.error_invalid
    "invalid_email" -> R.string.error_invalid_email
    "email" -> R.string.error_email
    "disabled" -> R.string.error_disabled
    "forbidden" -> R.string.error_forbidden
    "not_found" -> R.string.error_not_found
    "unauthorized" -> R.string.error_unauthorized
    "closed" -> R.string.error_closed
    "expired" -> R.string.error_expired
    "plan" -> when {
        pastDue && owner -> R.string.error_plan_past_due
        pastDue -> R.string.error_plan_past_due_member
        owner -> R.string.error_plan
        else -> R.string.error_plan_member
    }
    "pending_expired" -> R.string.error_pending_expired
    "passkey_failed" -> R.string.error_passkey_failed
    "passkey_counter" -> R.string.error_passkey_counter
    "passkey_exists" -> R.string.error_passkey_exists
    "passkey_cancelled" -> R.string.error_passkey_cancelled
    "passkey_unusable" -> R.string.error_passkey_unusable
    "passkey_already" -> R.string.error_passkey_already
    "passkey_none" -> R.string.error_passkey_none
    "current_session" -> R.string.error_current_session
    "cannot_target_self" -> R.string.error_cannot_target_self
    "attestation" -> R.string.error_attestation
    "storage" -> R.string.error_storage
    "unavailable" -> R.string.error_unavailable
    else -> R.string.error_server_error
}

@Composable
fun ErrorNote(code: String?) {
    if (code != null) Text(stringResource(errorText(code)), color = MaterialTheme.colorScheme.error, modifier = Modifier.fillMaxWidth())
}
