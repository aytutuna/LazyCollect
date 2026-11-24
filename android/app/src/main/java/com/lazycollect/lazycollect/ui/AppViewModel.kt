package com.lazycollect.lazycollect.ui

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import com.lazycollect.lazycollect.CollectApp
import com.lazycollect.lazycollect.client.ClientModel
import com.lazycollect.lazycollect.client.startUploads
import com.lazycollect.lazycollect.net.ClientItem
import com.lazycollect.lazycollect.shell.AppModel
import com.lazycollect.lazycollect.shell.DevicesModel
import com.lazycollect.lazycollect.shell.FirmModel
import com.lazycollect.lazycollect.signin.SignInModel
import java.io.File
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class AppViewModel(app: Application, saved: SavedStateHandle) : AndroidViewModel(app) {
    private val graph = (app as CollectApp).graph

    val session = graph.session
    val account = AppModel(viewModelScope, graph.api, graph.session)
    val signIn = SignInModel(viewModelScope, graph.api, graph.attester, graph.passkeys, saved, graph.session::start)
    val firm = FirmModel(viewModelScope, graph.api, account::reload)
    val devices = DevicesModel(viewModelScope, graph.api)
    val clientSession = graph.clientSession
    val client = ClientModel(viewModelScope, graph.clientApi, graph.clientSession, graph.attester, graph.uploads) { startUploads(app) }

    init {
        // whatever was loaded belongs to the account that was signed in
        viewModelScope.launch {
            session.token.collect {
                firm.reset()
                devices.reset()
            }
        }
    }

    /** Reads what the person chose, makes it ready (photos scaled, several merged into one PDF) and queues it. */
    fun pick(item: ClientItem, uris: List<Uri>) {
        val resolver = getApplication<Application>().contentResolver
        viewModelScope.launch(Dispatchers.IO) {
            val named = uris.map { uri ->
                val shown = if (uri.authority?.endsWith(CAMERA_SUFFIX) == true) null else resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null }
                uri to (shown ?: item.label)
            }
            client.add(item.id, graph.prepare.all(named, item.label))
        }
    }

    fun cameraUri(): Uri {
        val app = getApplication<Application>()
        val dir = File(app.cacheDir, "camera").apply { mkdirs() }
        return FileProvider.getUriForFile(app, app.packageName + CAMERA_SUFFIX, File(dir, UUID.randomUUID().toString() + ".jpg"))
    }
}

private const val CAMERA_SUFFIX = ".files"
