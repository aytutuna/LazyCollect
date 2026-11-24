package com.lazycollect.lazycollect.shell

import com.lazycollect.lazycollect.net.Api
import com.lazycollect.lazycollect.net.ApiError
import com.lazycollect.lazycollect.net.Device
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** The places this person is signed in, for Settings. */
class DevicesModel(private val scope: CoroutineScope, private val api: Api) {
    private val flow = MutableStateFlow(DevicesState())
    private var job: Job? = null

    val state: StateFlow<DevicesState> get() = flow

    fun load() = run { }

    fun reset() {
        job?.cancel()
        flow.value = DevicesState()
    }

    fun end(id: String) = run { api.endDevice(id) }

    fun endOthers() = run { api.endOthers() }

    private fun run(change: suspend () -> Unit) {
        flow.update { it.copy(busy = true, error = null) }
        job = scope.launch {
            try {
                change()
                flow.value = DevicesState(devices = api.devices())
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                flow.update { it.copy(busy = false, error = e.code) }
            }
        }
    }
}

data class DevicesState(val devices: List<Device>? = null, val busy: Boolean = false, val error: String? = null)
