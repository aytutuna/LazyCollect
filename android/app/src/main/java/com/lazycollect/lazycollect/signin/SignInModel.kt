package com.lazycollect.lazycollect.signin

import android.content.Context
import androidx.lifecycle.SavedStateHandle
import com.lazycollect.lazycollect.net.Api
import com.lazycollect.lazycollect.net.ApiError
import com.lazycollect.lazycollect.net.Attestation
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class Step { Email, Code, Passkey, Enrol }

/** [error] is a server error code, or one of the passkey_* and attestation codes this side makes up. */
data class SignInState(
    val step: Step = Step.Email,
    val email: String = "",
    val busy: Boolean = false,
    val error: String? = null,
    val owner: Boolean = false,
)

private val EMAIL = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")

// The server cleans the address with JS trim(), whose idea of a space differs from Kotlin's; the integrity hash needs the same string.
private fun isJsSpace(c: Char) = c in '\t'..'\r' || c == '\uFEFF' || c == '\u2028' || c == '\u2029' || Character.getType(c) == Character.SPACE_SEPARATOR.toInt()

private const val EMAIL_KEY = "email"
private const val CODE_KEY = "code"

class SignInModel(
    private val scope: CoroutineScope,
    private val api: Api,
    private val attester: Attester,
    private val passkeys: Passkeys,
    private val saved: SavedStateHandle = SavedStateHandle(),
    private val signedIn: (String) -> Unit,
) {
    // only the code step is kept across process death; a pending passkey login is not, and starts again from the email
    private val flow = MutableStateFlow(SignInState(if (saved.get<Boolean>(CODE_KEY) == true) Step.Code else Step.Email, saved.get<String>(EMAIL_KEY).orEmpty()))
    private var pending: String? = null
    private var autoPasskey = false

    // every try gets a number; going back or starting another try makes the earlier ones stale
    @Volatile private var attempt = 0

    val state: StateFlow<SignInState> get() = flow

    init {
        scope.launch {
            flow.collect {
                saved[EMAIL_KEY] = it.email
                saved[CODE_KEY] = it.step == Step.Code
            }
        }
    }

    private fun run(block: suspend (current: () -> Boolean) -> Unit) {
        val mine = ++attempt
        val current = { attempt == mine }
        flow.update { it.copy(busy = true, error = null) }
        scope.launch {
            try {
                block(current)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                // a try that outlived its screen must not touch what the person has moved on to
                if (current()) fail(e.code)
            } catch (e: PasskeyFailed) {
                if (current()) fail("passkey_${e.reason}")
            } finally {
                if (current()) flow.update { it.copy(busy = false) }
            }
        }
    }

    private fun fail(code: String) {
        // a sign-in that timed out or was refused is over; the next try starts from the email again
        if (code == "pending_expired" || code == "passkey_counter" || code == "storage") {
            pending = null
            flow.update { it.copy(step = Step.Email) }
        }
        flow.update { it.copy(error = code) }
    }

    fun sendCode(input: String) {
        val email = input.trim(::isJsSpace).lowercase()
        if (email.length > 254 || !EMAIL.matches(email)) {
            flow.update { it.copy(email = input, error = "invalid_email") }
            return
        }
        flow.update { it.copy(email = email) }
        run { current ->
            // a challenge works once, so every attempt gets its own
            val challenge = api.challenge()
            val attestation = if (challenge.required) Attestation(challenge.challenge, attest(requestHash(challenge.challenge, email))) else null
            api.start(email, attestation)
            if (current()) flow.update { it.copy(step = Step.Code) }
        }
    }

    private suspend fun attest(hash: String): String =
        try {
            attester.token(hash)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw ApiError.Other(0, "attestation")
        }

    fun verify(code: String) {
        val email = flow.value.email
        run { current ->
            val result = api.verify(email, code.trim())
            val token = result.token
            val held = result.pending
            if (!current()) {
                token?.let { end(it) }
                held?.let { endPending(it) }
                return@run
            }
            if (token != null) {
                done(token)
            } else if (held != null && (result.step == "passkey" || result.step == "enrol")) {
                val role = runCatching { api.pending(held).role }.getOrNull()
                if (!current()) {
                    endPending(held)
                    return@run
                }
                pending = held
                autoPasskey = result.step == "passkey"
                flow.update { it.copy(step = if (result.step == "enrol") Step.Enrol else Step.Passkey, owner = role == "owner") }
            } else {
                throw ApiError.Other(200, "server_error")
            }
        }
    }

    /** Starts the passkey prompt once for each pending login, so a recreated screen does not open it again. */
    fun autoPasskey(host: Context) {
        if (!autoPasskey) return
        autoPasskey = false
        usePasskey(host, "")
    }

    fun usePasskey(host: Context, name: String) {
        val held = pending ?: return
        if (flow.value.busy) return
        run { current ->
            val options = api.passkeyOptions(held)
            if (!current()) return@run
            val response = if (options.kind == "register") passkeys.create(host, options.options) else passkeys.get(host, options.options)
            val token = api.passkeyVerify(held, response, name.trim())
            if (current()) done(token) else end(token)
        }
    }

    fun back() {
        attempt++
        pending?.let { held -> scope.launch { endPending(held) } }
        pending = null
        autoPasskey = false
        flow.update { it.copy(step = Step.Email, busy = false, error = null) }
    }

    private suspend fun done(token: String) {
        try {
            signedIn(token)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // the server has made the session already; without a place to keep the token it would only linger under Devices
            end(token)
            throw ApiError.Other(0, "storage")
        }
        pending = null
        flow.value = SignInState()
    }

    private suspend fun end(token: String) {
        withContext(NonCancellable) { runCatching { api.logout(token) } }
    }

    private suspend fun endPending(held: String) {
        withContext(NonCancellable) { runCatching { api.endPending(held) } }
    }
}
