package com.lazycollect.lazycollect.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.unit.dp
import com.lazycollect.lazycollect.R
import com.lazycollect.lazycollect.shell.Action

@Composable
fun LinkScreen(action: Action, onOpen: (String) -> Unit, onBack: () -> Unit) {
    var link by rememberSaveable { mutableStateOf("") }
    BackHandler(onBack = onBack)
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.safeDrawingPadding().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.primary)
            Text(stringResource(R.string.link_title), style = MaterialTheme.typography.titleLarge)
            Text(stringResource(R.string.link_intro), color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(value = link, onValueChange = { link = it }, label = { Text(stringResource(R.string.link_field)) }, modifier = Modifier.fillMaxWidth())
            ErrorNote(action.error)
            Button(enabled = !action.busy && link.isNotBlank(), onClick = { onOpen(link) }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.link_go)) }
            TextButton(onClick = onBack) { Text(stringResource(R.string.link_back)) }
        }
    }
}
