package com.lazycollect.lazycollect.client

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.lazycollect.lazycollect.CollectApp
import java.util.concurrent.TimeUnit

/** Sends the queued files in the background, so a file still goes when the app is closed or the phone had no signal. */
class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = when ((applicationContext as CollectApp).graph.uploads.run()) {
        Pass.Later -> Result.retry()
        else -> Result.success()
    }
}

fun startUploads(context: Context) {
    val work = OneTimeWorkRequestBuilder<UploadWorker>()
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
        .build()
    WorkManager.getInstance(context).enqueueUniqueWork("uploads", ExistingWorkPolicy.REPLACE, work)
}
