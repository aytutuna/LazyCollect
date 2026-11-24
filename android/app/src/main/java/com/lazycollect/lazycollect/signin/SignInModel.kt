package com.lazycollect.lazycollect.signin

import android.content.Context
import com.lazycollect.lazycollect.net.Api
import com.lazycollect.lazycollect.net.ApiError
import com.lazycollect.lazycollect.net.Attestation
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

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

class SignInModel(
    private val scope: CoroutineScope,
    private val api: Api,
    private val attester: Attester,
    private val passkeys: Passkeys,
    private val signedIn: (String) -> Unit,
) {
    private val flow = MutableStateFlow(SignInState())
    private var pending: String? = null

    val state: StateFlow<SignInState> get() = flow

    private fun run(block: suspend () -> Unit) {
        flow.update { it.copy(busy = true, error = null) }
        scope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                fail(e.code)
            } catch (e: PasskeyFailed) {
                fail("passkey_${e.reason}")
            } finally {
                flow.update { it.copy(busy = false) }
            }
        }
    }

    private fun fail(code: String) {
        // a sign-in that timed out or was refused is over; the next try starts from the email again
        if (code == "pending_expired" || code == "passkey_counter") {
            pending = null
            flow.update { it.copy(step = Step.Email) }
        }
        flow.update { it.copy(error = code) }
    }

    fun sendCode(input: String) {
        val email = input.trim().lowercase()
        if (email.length > 254 || !EMAIL.matches(email)) {
            flow.update { it.copy(email = input, error = "invalid_email") }
            return
        }
        flow.update { it.copy(email = email) }
        run {
            // a challenge works once, so every attempt gets its own
            val challenge = api.challenge()
            val attestation = if (challenge.required) Attestation(challenge.challenge, attest(requestHash(challenge.challenge, email))) else null
            api.start(email, attestation)
            flow.update { it.copy(step = Step.Code) }
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
        run {
            val result = api.verify(flow.value.email, code.trim())
            val token = result.token
            val held = result.pending
            if (token != null) {
                done(token)
            } else if (held != null && (result.step == "passkey" || result.step == "enrol")) {
                pending = held
                val role = runCatching { api.pending(held).role }.getOrNull()
                flow.update { it.copy(step = if (result.step == "enrol") Step.Enrol else Step.Passkey, owner = role == "owner") }
            } else {
                throw ApiError.Other(200, "server_error")
            }
        }
    }

    fun usePasskey(host: Context, name: String) {
        val held = pending ?: return
        run {
            val options = api.passkeyOptions(held)
            val response = if (options.kind == "register") passkeys.create(host, options.options) else passkeys.get(host, options.options)
            done(api.passkeyVerify(held, response, name.trim()))
        }
    }

    fun back() {
        pending?.let { held -> scope.launch { runCatching { api.endPending(held) } } }
        pending = null
        flow.update { it.copy(step = Step.Email, error = null) }
    }

    private fun done(token: String) {
        pending = null
        signedIn(token)
        flow.value = SignInState()
    }
}
