package com.lazycollect.lazycollect.net

import java.io.File
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.RequestBody
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.coroutines.executeAsync
import okio.Buffer
import okio.BufferedSink
import okio.ForwardingSink
import okio.buffer

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

    private suspend fun send(
        method: String,
        path: String,
        body: String?,
        pending: String?,
        asToken: String? = null,
        raw: RequestBody? = null,
        headers: Map<String, String> = emptyMap(),
    ): String = sendBytes(method, path, body, pending, asToken, raw, headers).decodeToString()

    private suspend fun sendBytes(
        method: String,
        path: String,
        body: String?,
        pending: String?,
        asToken: String? = null,
        raw: RequestBody? = null,
        headers: Map<String, String> = emptyMap(),
    ): ByteArray = withContext(io) {
        val bearer = if (pending == null) asToken ?: token() else null
        val request = Request.Builder().url(base.resolve("/api$path")!!)
        when {
            pending != null -> request.header("Authorization", "Pending $pending")
            bearer != null -> request.header("Authorization", "Bearer $bearer")
        }
        if (method != "GET") request.header("X-Collect", "1")
        headers.forEach { (name, value) -> request.header(name, value) }
        request.method(method, if (method == "GET") null else raw ?: (body ?: "").toRequestBody(JSON_TYPE))
        try {
            http.newCall(request.build()).executeAsync().use { response ->
                val bytes = response.body.bytes()
                if (!response.isSuccessful) throw errorOf(response.code, bytes.decodeToString(), bearer != null)
                bytes
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

    suspend fun requests(view: String, sort: String, status: String?, client: String?, query: String, offset: Int): RequestPage {
        val q = buildString {
            append("?view=$view&sort=$sort")
            if (status != null) append("&status=$status")
            if (client != null) append("&client=$client")
            if (query.isNotEmpty()) append("&q=").append(URLEncoder.encode(query, "UTF-8").replace("+", "%20"))
            if (offset > 0) append("&offset=$offset")
        }
        return call("GET", "/requests$q")
    }

    suspend fun request(id: String): RequestDetail = call("GET", "/requests/$id")

    suspend fun thread(id: String): NoteThread = call("GET", "/requests/$id/notes")

    suspend fun reply(id: String, body: String): NoteReply = call("POST", "/requests/$id/notes", ApiJson.encodeToString(NoteBody(body)))

    suspend fun review(id: String, item: String, review: ReviewBody) {
        send("POST", "/requests/$id/items/$item/review", ApiJson.encodeToString(review), null)
    }

    suspend fun unavailable(id: String, item: String, decision: UnavailableDecision) {
        send("POST", "/requests/$id/items/$item/unavailable", ApiJson.encodeToString(decision), null)
    }

    suspend fun link(id: String): LinkInfo = call("GET", "/requests/$id/link")

    suspend fun makeLink(id: String, email: Boolean): LinkMade = call("POST", "/requests/$id/link", ApiJson.encodeToString(LinkBody(email)))

    suspend fun remind(id: String) {
        send("POST", "/requests/$id/remind", null, null)
    }

    /** A file's bytes as the client uploaded them. The server counts every call as a view and limits how many a minute. */
    suspend fun fileBytes(id: String): ByteArray = sendBytes("GET", "/files/$id", null, null)

    suspend fun devices(): List<Device> = call("GET", "/sessions")

    suspend fun endDevice(id: String) {
        send("DELETE", "/sessions/$id", null, null)
    }

    suspend fun endOthers() {
        send("POST", "/sessions/end-others", null, null)
    }

    /** Ends the session of [asToken] when it is not the one the app holds yet. */
    suspend fun logout(asToken: String? = null) {
        send("POST", "/auth/logout", null, null, asToken)
    }

    /** Trades the link a client was sent for a session of the app's own. */
    suspend fun exchange(link: String, attestation: Attestation?): Exchange =
        call("POST", "/app/client/exchange", ApiJson.encodeToString(ExchangeRequest(link, attestation)))

    suspend fun clientLogout(asToken: String? = null) {
        send("POST", "/app/client/logout", null, null, asToken)
    }

    suspend fun view(): ClientView = call("GET", "/c/me")

    suspend fun answer(item: String, answer: JsonElement): List<ClientItem> =
        call<ItemsReply>("PUT", "/c/me/items/$item/answer", buildJsonObject { put("answer", answer) }.toString()).items

    suspend fun dates(item: String, expiresOn: String?, issuedOn: String?, setExpires: Boolean, setIssued: Boolean): List<ClientItem> {
        val body = buildJsonObject {
            if (setExpires) put("expires_on", expiresOn)
            if (setIssued) put("issued_on", issuedOn)
        }
        return call<ItemsReply>("PUT", "/c/me/items/$item/dates", body.toString()).items
    }

    suspend fun unavailable(item: String, note: String) {
        send("POST", "/c/me/items/$item/unavailable", ApiJson.encodeToString(UnavailableBody(note)), null)
    }

    suspend fun found(item: String) {
        send("DELETE", "/c/me/items/$item/unavailable", null, null)
    }

    suspend fun note(body: String) {
        send("POST", "/c/me/notes", ApiJson.encodeToString(NoteBody(body)), null)
    }

    suspend fun deleteFile(id: String) {
        send("DELETE", "/c/me/files/$id", null, null)
    }

    /** The picture a professional added to show what an item should look like. */
    suspend fun example(item: String): ByteArray = sendBytes("GET", "/c/me/items/$item/example", null, null)

    /** One file as the raw body, with its length, so the server can refuse a big one before it reads it. [uploadId] makes a repeat harmless. */
    suspend fun upload(item: String, name: String, uploadId: String, file: File, onSent: (Long) -> Unit = {}) {
        val body = ProgressBody(file.asRequestBody("application/octet-stream".toMediaType()), onSent)
        val headers = mapOf("Upload-Id" to uploadId, "X-File-Name" to URLEncoder.encode(name, "UTF-8").replace("+", "%20"))
        send("PUT", "/c/me/items/$item/files", null, null, raw = body, headers = headers)
    }
}

/** Passes a body through and says how much of it has gone, at most about every percent. */
private class ProgressBody(private val body: RequestBody, private val onSent: (Long) -> Unit) : RequestBody() {
    override fun contentType() = body.contentType()

    override fun contentLength() = body.contentLength()

    override fun isOneShot() = body.isOneShot()

    override fun writeTo(sink: BufferedSink) {
        val total = body.contentLength()
        val step = maxOf(total / 100, 1L)
        var sent = 0L
        var reported = 0L
        val counting = object : ForwardingSink(sink) {
            override fun write(source: Buffer, byteCount: Long) {
                super.write(source, byteCount)
                sent += byteCount
                if (sent - reported >= step || sent == total) {
                    reported = sent
                    onSent(sent)
                }
            }
        }.buffer()
        body.writeTo(counting)
        counting.flush()
    }
}
