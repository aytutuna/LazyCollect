package com.lazycollect.lazycollect.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** Whether someone is signed in, and whether the server has said the plan ended. The token stays on disk until [end]. */
class Session(private val store: TokenStore) {
    private val signedIn = MutableStateFlow(store.load())
    private val ended = MutableStateFlow(false)

    val token: StateFlow<String?> get() = signedIn
    val planEnded: StateFlow<Boolean> get() = ended

    fun start(token: String) {
        store.save(token)
        signedIn.value = token
    }

    fun end() {
        store.clear()
        signedIn.value = null
        ended.value = false
    }

    fun planHasEnded() {
        ended.value = true
    }

    fun planIsFine() {
        ended.value = false
    }
}
