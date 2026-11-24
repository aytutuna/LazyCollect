package com.lazycollect.lazycollect.client

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.lazycollect.lazycollect.CollectApp
import com.lazycollect.lazycollect.R
import java.util.concurrent.TimeUnit

private const val CHANNEL = "uploads"
private const val NOTIFICATION = 7

/** Sends the queued files in the background, so a file still goes when the app is closed or the phone had no signal. */
class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val queue = (applicationContext as CollectApp).graph.uploads
        if (queue.run() == Pass.Later) queue.nextAttempt()?.let { scheduleLater(applicationContext, it - System.currentTimeMillis()) }
        return Result.success()
    }

    // Before Android 12 expedited work runs as a foreground service, which needs this notice; later it only shows if the work runs long.
    override suspend fun getForegroundInfo(): ForegroundInfo {
        val manager = applicationContext.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, applicationContext.getString(R.string.upload_channel), NotificationManager.IMPORTANCE_LOW))
        val notice = NotificationCompat.Builder(applicationContext, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(applicationContext.getString(R.string.upload_channel))
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(NOTIFICATION, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else ForegroundInfo(NOTIFICATION, notice)
    }
}

private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

/**
 * Starts a pass unless one is queued or running; the running one notices what was added and goes round again, so a kick never
 * cancels an upload and there is never more than one waiting.
 */
fun startUploads(context: Context) {
    val work = OneTimeWorkRequestBuilder<UploadWorker>()
        .setConstraints(online)
        .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        .build()
    WorkManager.getInstance(context).enqueueUniqueWork("uploads", ExistingWorkPolicy.KEEP, work)
}

// Only a wake-up for the file that waits longest: it kicks the pass above, so replacing it can never cancel an upload.
private fun scheduleLater(context: Context, delayMs: Long) {
    val work = OneTimeWorkRequestBuilder<LaterWorker>()
        .setConstraints(online)
        .setInitialDelay(delayMs.coerceAtLeast(1000), TimeUnit.MILLISECONDS)
        .build()
    WorkManager.getInstance(context).enqueueUniqueWork("uploads-later", ExistingWorkPolicy.REPLACE, work)
}

class LaterWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        (applicationContext as CollectApp).graph.uploads.touch()
        startUploads(applicationContext)
        return Result.success()
    }
}

fun stopUploads(context: Context) {
    val manager = WorkManager.getInstance(context)
    manager.cancelUniqueWork("uploads")
    manager.cancelUniqueWork("uploads-later")
}
