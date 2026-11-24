package com.lazycollect.lazycollect

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.lazycollect.lazycollect.ui.AppViewModel
import com.lazycollect.lazycollect.ui.LazyCollectTheme
import com.lazycollect.lazycollect.ui.Root

class MainActivity : ComponentActivity() {
    private val model: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        askForLocalNetwork(this)
        if (savedInstanceState == null) openLink(intent)
        setContent { LazyCollectTheme { Root(model) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        openLink(intent)
    }

    private fun openLink(intent: Intent) {
        intent.data?.takeIf { intent.action == Intent.ACTION_VIEW }?.let { model.client.open(it.toString()) }
    }
}
