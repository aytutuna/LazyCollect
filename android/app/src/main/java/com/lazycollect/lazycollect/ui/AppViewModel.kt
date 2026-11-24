package com.lazycollect.lazycollect.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.lazycollect.lazycollect.CollectApp
import com.lazycollect.lazycollect.shell.AppModel
import com.lazycollect.lazycollect.shell.DevicesModel
import com.lazycollect.lazycollect.shell.FirmModel
import com.lazycollect.lazycollect.signin.SignInModel
import kotlinx.coroutines.launch

class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val graph = (app as CollectApp).graph

    val session = graph.session
    val account = AppModel(viewModelScope, graph.api, graph.session)
    val signIn = SignInModel(viewModelScope, graph.api, graph.attester, graph.passkeys, graph.session::start)
    val firm = FirmModel(viewModelScope, graph.api, account::reload)
    val devices = DevicesModel(viewModelScope, graph.api)

    init {
        // whatever was loaded belongs to the account that was signed in
        viewModelScope.launch {
            session.token.collect {
                firm.reset()
                devices.reset()
            }
        }
    }
}
