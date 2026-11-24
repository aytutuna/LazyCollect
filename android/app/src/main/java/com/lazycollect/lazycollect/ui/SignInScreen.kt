package com.lazycollect.lazycollect.ui

import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.lazycollect.lazycollect.R
import com.lazycollect.lazycollect.signin.SignInState
import com.lazycollect.lazycollect.signin.Step

class SignInActions(
    val sendCode: (String) -> Unit = {},
    val verify: (String) -> Unit = {},
    val passkey: (Context, String) -> Unit = { _, _ -> },
    val autoPasskey: (Context) -> Unit = {},
    val back: () -> Unit = {},
)

private const val LEGAL = "https://alazy.app/collect/"

@Composable
fun SignInScreen(state: SignInState, actions: SignInActions) {
    BackHandler(enabled = state.step != Step.Email, onBack = actions.back)
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
        Column(
            Modifier.safeDrawingPadding().verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.primary)
            when (state.step) {
                Step.Email -> EmailStep(state, actions)
                Step.Code -> CodeStep(state, actions)
                Step.Passkey, Step.Enrol -> PasskeyStep(state, actions)
            }
        }
    }
}

@Composable
private fun EmailStep(state: SignInState, actions: SignInActions) {
    var email by rememberSaveable { mutableStateOf(state.email) }
    val links = LocalUriHandler.current
    Text(stringResource(R.string.signin_title), style = MaterialTheme.typography.titleLarge)
    Text(stringResource(R.string.signin_intro), color = MaterialTheme.colorScheme.onSurfaceVariant)
    OutlinedTextField(
        value = email,
        onValueChange = { email = it },
        label = { Text(stringResource(R.string.signin_email)) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
        modifier = Modifier.fillMaxWidth().semantics { contentType = ContentType.EmailAddress },
    )
    ErrorNote(state.error)
    Button(onClick = { actions.sendCode(email) }, enabled = !state.busy && email.isNotBlank()) {
        Text(stringResource(R.string.signin_send))
    }
    Text(stringResource(R.string.signin_agree, stringResource(R.string.legal_terms), stringResource(R.string.legal_privacy)), color = MaterialTheme.colorScheme.onSurfaceVariant)
    Row {
        TextButton(onClick = { links.openUri("${LEGAL}terms.html") }) { Text(stringResource(R.string.legal_terms)) }
        TextButton(onClick = { links.openUri("${LEGAL}privacy.html") }) { Text(stringResource(R.string.legal_privacy)) }
    }
}

@Composable
private fun CodeStep(state: SignInState, actions: SignInActions) {
    var code by rememberSaveable { mutableStateOf("") }
    Text(stringResource(R.string.signin_code_title), style = MaterialTheme.typography.titleLarge)
    Text(stringResource(R.string.signin_code_intro, state.email))
    Text(stringResource(R.string.signin_newest), color = MaterialTheme.colorScheme.onSurfaceVariant)
    OutlinedTextField(
        value = code,
        onValueChange = { code = it.filter(Char::isDigit).take(6) },
        label = { Text(stringResource(R.string.signin_code)) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
        modifier = Modifier.fillMaxWidth().semantics { contentType = ContentType.SmsOtpCode },
    )
    ErrorNote(state.error)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { actions.verify(code) }, enabled = !state.busy && code.length == 6) { Text(stringResource(R.string.signin_verify)) }
        TextButton(onClick = actions.back) { Text(stringResource(R.string.signin_other)) }
    }
}

@Composable
private fun PasskeyStep(state: SignInState, actions: SignInActions) {
    val enrol = state.step == Step.Enrol
    val host = LocalContext.current
    var name by rememberSaveable { mutableStateOf("") }
    // a passkey that is asked for starts by itself; adding one waits until the person has named it and pressed the button
    LaunchedEffect(state.step) { if (!enrol) actions.autoPasskey(host) }
    Text(stringResource(if (enrol) R.string.signin_enrol_title else R.string.signin_passkey_title), style = MaterialTheme.typography.titleLarge)
    Text(stringResource(if (enrol) R.string.signin_enrol_intro else R.string.signin_passkey_intro))
    if (enrol) {
        OutlinedTextField(
            value = name,
            onValueChange = { name = it.take(60) },
            label = { Text(stringResource(R.string.passkey_name)) },
            supportingText = { Text(stringResource(R.string.passkey_name_hint)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
    }
    ErrorNote(state.error)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { actions.passkey(host, name) }, enabled = !state.busy) {
            Text(stringResource(if (enrol) R.string.signin_enrol_go else if (state.error != null) R.string.signin_passkey_retry else R.string.signin_passkey_go))
        }
        TextButton(onClick = actions.back) { Text(stringResource(R.string.signin_other)) }
    }
    if (!enrol) {
        Text(stringResource(if (state.owner) R.string.signin_lost_owner else R.string.signin_lost_member), color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
