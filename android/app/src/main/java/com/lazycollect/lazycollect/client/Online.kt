package com.lazycollect.lazycollect.client

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** Where the phone's connection state comes from; a fake stands in for it in tests. */
interface NetworkSource {
    fun isOnline(): Boolean

    /** Calls [onChange] each time the phone gains or loses its connection. */
    fun listen(onChange: (Boolean) -> Unit)
}

class Online(source: NetworkSource) {
    private val flow = MutableStateFlow(source.isOnline())

    val state: StateFlow<Boolean> get() = flow

    init {
        source.listen { flow.value = it }
    }
}

class SystemNetwork(context: Context) : NetworkSource {
    private val manager = context.getSystemService(ConnectivityManager::class.java)

    override fun isOnline(): Boolean {
        val caps = manager.getNetworkCapabilities(manager.activeNetwork)
        return caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    }

    override fun listen(onChange: (Boolean) -> Unit) {
        manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = onChange(true)

            override fun onLost(network: Network) = onChange(false)
        })
    }
}
