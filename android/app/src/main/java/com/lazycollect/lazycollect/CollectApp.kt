package com.lazycollect.lazycollect

import android.app.Application
import com.lazycollect.lazycollect.client.Online
import com.lazycollect.lazycollect.client.Prepare
import com.lazycollect.lazycollect.client.UploadQueue
import com.lazycollect.lazycollect.client.SystemNetwork
import com.lazycollect.lazycollect.data.SecretBox
import com.lazycollect.lazycollect.data.Session
import com.lazycollect.lazycollect.data.TokenStore
import com.lazycollect.lazycollect.net.Api
import com.lazycollect.lazycollect.scan.CornerModels
import com.lazycollect.lazycollect.signin.CredentialPasskeys
import com.lazycollect.lazycollect.signin.PlayIntegrity
import java.io.File
import okhttp3.HttpUrl.Companion.toHttpUrl

class AppGraph(app: Application) {
    private val box = SecretBox()
    val session = Session(TokenStore(File(app.noBackupFilesDir, "session.bin"), box::seal, box::open))
    val api = Api(BuildConfig.API_BASE.toHttpUrl(), token = { session.token.value }, onSignedOut = session::end, onPlanEnded = session::planHasEnded)
    val clientSession = Session(TokenStore(File(app.noBackupFilesDir, "client.bin"), box::seal, box::open))
    val clientApi = Api(BuildConfig.API_BASE.toHttpUrl(), token = { clientSession.token.value }, onSignedOut = clientSession::end, onPlanEnded = {})
    val uploads = UploadQueue(File(app.noBackupFilesDir, "uploads"), clientApi)
    val online = Online(SystemNetwork(app))
    val prepare = Prepare(app)
    val corners by lazy { CornerModels.fromAssets(app) }
    val attester = PlayIntegrity(app, BuildConfig.CLOUD_PROJECT)
    val passkeys = CredentialPasskeys()
}

class CollectApp : Application() {
    val graph by lazy { AppGraph(this) }
}
