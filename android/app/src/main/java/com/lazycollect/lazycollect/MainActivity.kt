package com.lazycollect.lazycollect

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
        setContent { LazyCollectTheme { Root(model) } }
    }
}
