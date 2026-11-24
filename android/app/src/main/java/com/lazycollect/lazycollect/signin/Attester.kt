package com.lazycollect.lazycollect.signin

import android.content.Context
import com.google.android.gms.tasks.Task
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityManager.PrepareIntegrityTokenRequest
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenProvider
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenRequest
import java.security.MessageDigest
import java.util.Base64
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

/** What the server wants as proof that a sign-in comes from the real app on a real device. */
fun interface Attester {
    suspend fun token(requestHash: String): String
}

/** What the integrity token is bound to: the server computes the same from the challenge and the lower-cased email. */
fun requestHash(challenge: String, email: String): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest("$challenge.$email".toByteArray()))

class PlayIntegrity(context: Context, private val cloudProject: Long) : Attester {
    private val manager = IntegrityManagerFactory.createStandard(context.applicationContext)
    private var provider: StandardIntegrityTokenProvider? = null

    override suspend fun token(requestHash: String): String {
        try {
            val ready = provider ?: manager.prepareIntegrityToken(PrepareIntegrityTokenRequest.builder().setCloudProjectNumber(cloudProject).build()).await()
            provider = ready
            return ready.request(StandardIntegrityTokenRequest.builder().setRequestHash(requestHash).build()).await().token()
        } catch (e: Exception) {
            provider = null
            throw e
        }
    }
}

private suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { cont ->
    addOnSuccessListener { cont.resume(it) }
    addOnFailureListener { cont.resumeWithException(it) }
}
