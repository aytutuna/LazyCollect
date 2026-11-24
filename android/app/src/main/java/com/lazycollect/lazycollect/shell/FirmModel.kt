package com.lazycollect.lazycollect.shell

import com.lazycollect.lazycollect.net.Api
import com.lazycollect.lazycollect.net.ApiError
import com.lazycollect.lazycollect.net.Firm
import com.lazycollect.lazycollect.net.FirmUpdate
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** The account's name and business details, for the first-run screen. */
class FirmModel(private val scope: CoroutineScope, private val api: Api, private val saved: () -> Unit) {
    private val flow = MutableStateFlow(FirmState())
    private var job: Job? = null

    val state: StateFlow<FirmState> get() = flow

    /** For a screen that may be composed again with the form half filled in. */
    fun loadOnce() {
        val now = flow.value
        if (now.firm == null && now.error == null) load()
    }

    fun load() {
        flow.value = FirmState()
        job = scope.launch {
            try {
                flow.update { it.copy(firm = api.firm()) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                flow.update { it.copy(error = e.code) }
            }
        }
    }

    fun reset() {
        job?.cancel()
        flow.value = FirmState()
    }

    fun save(update: FirmUpdate) {
        flow.update { it.copy(busy = true, error = null) }
        job = scope.launch {
            try {
                api.saveFirm(update)
                flow.update { it.copy(busy = false) }
                saved()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                flow.update { it.copy(busy = false, error = e.code) }
            }
        }
    }
}

data class FirmState(val firm: Firm? = null, val busy: Boolean = false, val error: String? = null)
