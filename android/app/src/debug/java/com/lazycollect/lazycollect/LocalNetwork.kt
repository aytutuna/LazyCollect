package com.lazycollect.lazycollect

import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

private const val LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"

/** wrangler dev runs on a private address, which Android 17 lets an app reach only once the person has allowed it. */
fun askForLocalNetwork(activity: ComponentActivity) {
    if (Build.VERSION.SDK_INT < 37 || activity.checkSelfPermission(LOCAL_NETWORK) == PackageManager.PERMISSION_GRANTED) return
    activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) {}.launch(LOCAL_NETWORK)
}
