package com.lazycollect.lazycollect.shell

import com.lazycollect.lazycollect.data.Session
import com.lazycollect.lazycollect.net.Api
import com.lazycollect.lazycollect.net.ApiError
import com.lazycollect.lazycollect.net.Me
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

sealed interface MeState {
    data object Loading : MeState

    data class Ready(val me: Me) : MeState

    data class Failed(val code: String) : MeState
}

/** Who is signed in and what their account looks like, from the token on disk to GET /me. */
class AppModel(private val scope: CoroutineScope, private val api: Api, private val session: Session) {
    private val flow = MutableStateFlow<MeState>(MeState.Loading)
    private val acting = MutableStateFlow(Action())

    val me: StateFlow<MeState> get() = flow
    val action: StateFlow<Action> get() = acting

    init {
        scope.launch {
            session.token.collect {
                acting.value = Action()
                if (it != null) load()
            }
        }
    }

    private suspend fun load() {
        flow.value = MeState.Loading
        flow.value = try {
            val me = api.me()
            if (me.firm.usable) session.planIsFine()
            MeState.Ready(me)
        } catch (e: ApiError) {
            MeState.Failed(e.code)
        }
    }

    fun reload() {
        scope.launch { load() }
    }

    fun reopen() {
        act { api.reopen(); load() }
    }

    fun signOut() {
        scope.launch {
            // the token goes either way: a phone with no signal can still leave, and the server's copy times out
            runCatching { api.logout() }
            session.end()
        }
    }

    private fun act(block: suspend () -> Unit) {
        acting.value = Action(busy = true)
        scope.launch {
            try {
                block()
                acting.value = Action()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                acting.value = Action(error = e.code)
            }
        }
    }
}

data class Action(val busy: Boolean = false, val error: String? = null)
