package com.lazycollect.lazycollect.net

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.coroutines.executeAsync

/** What went wrong with a call. [code] is what the server's {error} says, or network and server_error when it said nothing. */
sealed class ApiError(val code: String) : Exception(code) {
    class Network : ApiError("network")
    class Unauthorized(code: String) : ApiError(code)
    class PlanEnded(code: String) : ApiError(code)
    class Conflict(code: String) : ApiError(code)
    class RateLimited(code: String) : ApiError(code)
    class Other(val status: Int, code: String) : ApiError(code)
}

private val JSON_TYPE = "application/json".toMediaType()

/**
 * The server's JSON API. A call carries the session token as a bearer; a 401 on such a call ends the session and a 402 says the
 * plan has ended. Nothing here logs: a URL or body can hold a token.
 */
class Api(
    private val base: HttpUrl,
    client: OkHttpClient = OkHttpClient(),
    private val token: () -> String?,
    private val onSignedOut: () -> Unit,
    private val onPlanEnded: () -> Unit,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val http = client.newBuilder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private suspend fun send(method: String, path: String, body: String?, pending: String?): String = withContext(io) {
        val bearer = if (pending == null) token() else null
        val request = Request.Builder().url(base.resolve("/api$path")!!)
        when {
            pending != null -> request.header("Authorization", "Pending $pending")
            bearer != null -> request.header("Authorization", "Bearer $bearer")
        }
        if (method != "GET") request.header("X-Collect", "1")
        request.method(method, if (method == "GET") null else (body ?: "").toRequestBody(JSON_TYPE))
        try {
            http.newCall(request.build()).executeAsync().use { response ->
                val text = response.body.string()
                if (!response.isSuccessful) throw errorOf(response.code, text, bearer != null)
                text
            }
        } catch (e: IOException) {
            throw ApiError.Network()
        }
    }

    private fun errorOf(status: Int, text: String, signedIn: Boolean): ApiError {
        val code = runCatching { ApiJson.decodeFromString<ErrorBody>(text).error }.getOrNull() ?: "server_error"
        return when (status) {
            401 -> ApiError.Unauthorized(code).also { if (signedIn) onSignedOut() }
            402 -> ApiError.PlanEnded(code).also { onPlanEnded() }
            409 -> ApiError.Conflict(code)
            429 -> ApiError.RateLimited(code)
            else -> ApiError.Other(status, code)
        }
    }

    private suspend inline fun <reified T> call(method: String, path: String, body: String? = null, pending: String? = null): T {
        val text = send(method, path, body, pending)
        return try {
            ApiJson.decodeFromString<T>(text)
        } catch (e: IllegalArgumentException) {
            throw ApiError.Other(200, "server_error")
        }
    }

    private suspend inline fun <reified B> post(path: String, body: B, pending: String? = null): String = send("POST", path, ApiJson.encodeToString(body), pending)

    suspend fun challenge(): Challenge = call("POST", "/app/challenge", """{"platform":"$PLATFORM"}""")

    suspend fun start(email: String, attestation: Attestation?) {
        post("/app/auth/start", StartRequest(email, attestation))
    }

    suspend fun verify(email: String, code: String): Verified = call("POST", "/app/auth/verify", ApiJson.encodeToString(VerifyRequest(email, code)))

    suspend fun pending(pending: String): PendingInfo = call("GET", "/auth/pending", pending = pending)

    suspend fun endPending(pending: String) {
        send("DELETE", "/auth/pending", null, pending)
    }

    suspend fun passkeyOptions(pending: String): PasskeyOptions = call("POST", "/auth/pending/options", pending = pending)

    suspend fun passkeyVerify(pending: String, response: JsonObject, name: String): String =
        call<Token>("POST", "/auth/pending/verify", ApiJson.encodeToString(PasskeyProof(response, name)), pending).token

    suspend fun me(): Me = call("GET", "/me")

    suspend fun firm(): Firm = call("GET", "/firm")

    suspend fun saveFirm(update: FirmUpdate) {
        send("PATCH", "/firm", ApiJson.encodeToString(update), null)
    }

    suspend fun reopen() {
        send("POST", "/account/reopen", null, null)
    }

    suspend fun devices(): List<Device> = call("GET", "/sessions")

    suspend fun endDevice(id: String) {
        send("DELETE", "/sessions/$id", null, null)
    }

    suspend fun endOthers() {
        send("POST", "/sessions/end-others", null, null)
    }

    suspend fun logout() {
        send("POST", "/auth/logout", null, null)
    }
}
