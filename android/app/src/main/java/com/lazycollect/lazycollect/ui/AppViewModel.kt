package com.lazycollect.lazycollect.ui

import android.app.Application
import android.graphics.Bitmap
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.FileProvider
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import com.lazycollect.lazycollect.CollectApp
import com.lazycollect.lazycollect.client.ClientModel
import com.lazycollect.lazycollect.client.ExampleRef
import com.lazycollect.lazycollect.client.decodeExample
import com.lazycollect.lazycollect.client.exampleRef
import com.lazycollect.lazycollect.client.parseExample
import com.lazycollect.lazycollect.client.renderExample
import com.lazycollect.lazycollect.client.startUploads
import com.lazycollect.lazycollect.R
import com.lazycollect.lazycollect.net.ClientItem
import com.lazycollect.lazycollect.scan.ScanFrameFeed
import com.lazycollect.lazycollect.scan.ScanModel
import com.lazycollect.lazycollect.scan.ScanPageStore
import com.lazycollect.lazycollect.shell.AppModel
import com.lazycollect.lazycollect.shell.DevicesModel
import com.lazycollect.lazycollect.shell.FirmModel
import com.lazycollect.lazycollect.signin.SignInModel
import java.io.File
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class AppViewModel(app: Application, saved: SavedStateHandle) : AndroidViewModel(app) {
    private val graph = (app as CollectApp).graph

    val session = graph.session
    val account = AppModel(viewModelScope, graph.api, graph.session)
    val signIn = SignInModel(viewModelScope, graph.api, graph.attester, graph.passkeys, saved, graph.session::start)
    val firm = FirmModel(viewModelScope, graph.api, account::reload)
    val devices = DevicesModel(viewModelScope, graph.api)
    val clientSession = graph.clientSession
    val client = ClientModel(viewModelScope, graph.clientApi, graph.clientSession, graph.attester, graph.uploads, graph.online.state) { startUploads(app) }

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

    /** The item being scanned, with the scanner that holds its pages; null while no scan is open. */
    var scanning by mutableStateOf<Pair<ClientItem, ScanModel>?>(null)
        private set

    /** Opens the scanner for a file item. Pages left from an earlier scan of the same item are still there. */
    fun scan(item: ClientItem) {
        val app = getApplication<Application>()
        val store = ScanPageStore(File(app.noBackupFilesDir, "scan/" + item.id))
        val finder = graph.corners
        val model = ScanModel(
            viewModelScope, store, finder, ScanFrameFeed(finder),
            finish = { pages ->
                val files = withContext(Dispatchers.IO) { graph.prepare.scanned(pages.map { it.jpeg }, item.label) }
                if (files.isEmpty()) throw java.io.IOException(app.getString(R.string.scan_not_finished))
                withContext(Dispatchers.IO) { client.add(item.id, files) }
                closeScan()
            },
            disk = Dispatchers.IO.limitedParallelism(1),
        )
        scanning = item to model
    }

    fun closeScan() {
        scanning?.second?.feed?.close()
        scanning = null
    }

    /** The picture that shows what an item should look like, or null when there is none or it cannot be had. */
    suspend fun example(item: ClientItem): Bitmap? = withContext(Dispatchers.IO) {
        when (val ref = exampleRef(item.example)) {
            is ExampleRef.Builtin -> runCatching { getApplication<Application>().assets.open("examples/${ref.name}.svg").use { renderExample(parseExample(it), 900) } }.getOrNull()
            ExampleRef.Uploaded -> client.example(item.id)?.let(::decodeExample)
            null -> null
        }
    }

    fun cameraUri(): Uri {
        val app = getApplication<Application>()
        val dir = File(app.cacheDir, "camera").apply { mkdirs() }
        return FileProvider.getUriForFile(app, app.packageName + CAMERA_SUFFIX, File(dir, UUID.randomUUID().toString() + ".jpg"))
    }
}

private const val CAMERA_SUFFIX = ".files"
