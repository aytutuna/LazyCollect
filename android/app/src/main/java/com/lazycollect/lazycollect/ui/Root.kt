package com.lazycollect.lazycollect.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.material3.Text
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lazycollect.lazycollect.R
import com.lazycollect.lazycollect.shell.MeState

@Composable
fun Root(vm: AppViewModel) {
    if (vm.pendingLink != null) {
        AlertDialog(
            onDismissRequest = vm::keepChecklist,
            title = { Text(stringResource(R.string.link_replace_title)) },
            text = { Text(stringResource(R.string.link_replace_body)) },
            confirmButton = { TextButton(onClick = vm::replaceChecklist) { Text(stringResource(R.string.link_replace_yes)) } },
            dismissButton = { TextButton(onClick = vm::keepChecklist) { Text(stringResource(R.string.link_replace_no)) } },
        )
    }
    val clientToken by vm.clientSession.token.collectAsStateWithLifecycle()
    if (clientToken != null) {
        ClientHost(vm)
        return
    }
    val token by vm.session.token.collectAsStateWithLifecycle()
    if (token == null) {
        var entering by rememberSaveable { mutableStateOf(false) }
        val opening by vm.client.action.collectAsStateWithLifecycle()
        if (entering || opening.busy || opening.error != null) {
            LinkScreen(opening, vm.client::open) {
                entering = false
                vm.client.clearError()
            }
            return
        }
        val state by vm.signIn.state.collectAsStateWithLifecycle()
        SignInScreen(state, SignInActions(vm.signIn::sendCode, vm.signIn::verify, vm.signIn::usePasskey, vm.signIn::autoPasskey, vm.signIn::back) { entering = true })
        return
    }
    val me by vm.account.me.collectAsStateWithLifecycle()
    when (val ready = me) {
        MeState.Loading -> Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        }
        is MeState.Failed -> Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
            Column(Modifier.safeDrawingPadding().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                ErrorNote(ready.code)
                Button(onClick = vm.account::reload) { Text(stringResource(R.string.retry)) }
                OutlinedButton(onClick = vm.account::signOut) { Text(stringResource(R.string.nav_signout)) }
            }
        }
        is MeState.Ready -> {
            val account = ready.me
            val action by vm.account.action.collectAsStateWithLifecycle()
            if (account.firm.closedAt != null) {
                ClosedScreen(account, System.currentTimeMillis(), action, vm.account::reopen, vm.account::signOut)
            } else if (account.firm.name.isNullOrEmpty()) {
                val firm by vm.firm.state.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) { vm.firm.loadOnce() }
                SetupScreen(firm, account.user.owner, vm.firm::save, vm.firm::load, vm.account::signOut)
            } else {
                val devices by vm.devices.state.collectAsStateWithLifecycle()
                val blocked by vm.session.planEnded.collectAsStateWithLifecycle()
                ShellScreen(account, blocked, devices, ShellActions(vm.devices::load, vm.devices::end, vm.devices::endOthers, vm.account::signOut), requests = vm.requestsHost)
            }
        }
    }
}

@Composable
private fun ClientHost(vm: AppViewModel) {
    val state by vm.client.state.collectAsStateWithLifecycle()
    val action by vm.client.action.collectAsStateWithLifecycle()
    val jobs by vm.client.jobs.collectAsStateWithLifecycle()
    val dropped by vm.client.dropped.collectAsStateWithLifecycle()
    val progress by vm.client.progress.collectAsStateWithLifecycle()
    val online by vm.client.connected.collectAsStateWithLifecycle()
    val take = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture(), vm::cameraDone)
    val client = vm.client
    val actions = remember {
        ClientActions(
            reload = client::reload,
            leave = client::leave,
            answer = client::answer,
            dates = client::dates,
            unavailable = client::unavailable,
            found = client::found,
            sendNote = client::send,
            removeFile = client::removeFile,
            pick = vm::pick,
            scan = vm::scan,
            camera = { item -> take.launch(vm.cameraUri(item)) },
            retryJob = client::retry,
            dropJob = client::drop,
            example = vm::example,
        )
    }
    LaunchedEffect(dropped) { if (dropped > 0) vm.client.acknowledgeDropped() }
    ClientRoot(state, action, jobs, dropped, actions, progress, !online)
    vm.scanning?.let { (item, scan) -> ScanScreen(item.label, scan, vm::closeScan) }
}
