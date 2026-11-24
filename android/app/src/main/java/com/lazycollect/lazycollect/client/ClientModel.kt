package com.lazycollect.lazycollect.client

import com.lazycollect.lazycollect.data.Session
import com.lazycollect.lazycollect.net.Api
import com.lazycollect.lazycollect.net.ApiError
import com.lazycollect.lazycollect.net.Attestation
import com.lazycollect.lazycollect.net.ClientItem
import com.lazycollect.lazycollect.net.ClientView
import com.lazycollect.lazycollect.shell.Action
import com.lazycollect.lazycollect.signin.Attester
import com.lazycollect.lazycollect.signin.requestHash
import java.io.IOException
import java.security.GeneralSecurityException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

sealed interface ClientState {
    data object Loading : ClientState

    /** [stale] is set when a refresh failed and what shows may be out of date. */
    data class Ready(val view: ClientView, val stale: Boolean = false) : ClientState

    /** The link has expired, was replaced or its request was closed. */
    data object Gone : ClientState

    data class Failed(val code: String) : ClientState
}

/** The checklist of one request, seen with the session a link was traded for. */
class ClientModel(
    private val scope: CoroutineScope,
    private val api: Api,
    private val session: Session,
    private val attester: Attester,
    private val queue: UploadQueue,
    private val kick: () -> Unit,
) {
    private val flow = MutableStateFlow<ClientState>(ClientState.Loading)
    private val acting = MutableStateFlow(Action())
    private val gone = MutableStateFlow(0)

    val state: StateFlow<ClientState> get() = flow
    val action: StateFlow<Action> get() = acting
    val jobs get() = queue.jobs

    /** How many waiting files were dropped because their item left the list; shown once. */
    val dropped: StateFlow<Int> get() = gone

    fun acknowledgeDropped() {
        gone.value = 0
    }

    init {
        scope.launch {
            session.token.collect {
                if (it == null) {
                    queue.forget()
                } else {
                    flow.value = ClientState.Loading
                    load()
                }
            }
        }
    }

    /** Trades a pasted address or token for a session. The checklist loads once the session is saved. */
    fun open(link: String) {
        val token = linkToken(link)
        if (token == null) {
            acting.value = Action(error = "invalid_link")
            return
        }
        act {
            val challenge = api.challenge()
            val attestation = if (challenge.required) Attestation(challenge.challenge, attest(requestHash(challenge.challenge, token))) else null
            val exchanged = api.exchange(token, attestation)
            try {
                session.start(exchanged.token)
            } catch (e: GeneralSecurityException) {
                unsaved(exchanged.token)
            } catch (e: IOException) {
                unsaved(exchanged.token)
            }
        }
    }

    private suspend fun unsaved(token: String): Nothing {
        runCatching { api.clientLogout(token) }
        throw ApiError.Other(0, "storage")
    }

    private suspend fun attest(hash: String): String =
        try {
            attester.token(hash)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw ApiError.Other(0, "attestation")
        }

    private suspend fun load() {
        val before = flow.value as? ClientState.Ready
        try {
            show(api.view())
        } catch (e: ApiError.Other) {
            if (e.status == 404 || e.status == 410) {
                queue.forget()
                flow.value = ClientState.Gone
            } else {
                fail(before, e)
            }
        } catch (e: ApiError) {
            fail(before, e)
        }
    }

    private fun fail(before: ClientState.Ready?, e: ApiError) {
        // a refresh that fails keeps what was shown, marked as possibly old
        flow.value = if (before != null) before.copy(stale = true) else ClientState.Failed(e.code)
    }

    private fun show(view: ClientView) {
        val dropped = queue.reconcile(view.items.map { it.id }.toSet())
        if (dropped > 0) gone.value = dropped
        flow.value = ClientState.Ready(view)
        if (queue.jobs.value.any { it.failed == null }) kick()
    }

    fun reload() {
        scope.launch { load() }
    }

    private fun replaceItems(items: List<ClientItem>) {
        val now = flow.value as? ClientState.Ready ?: return
        flow.value = now.copy(view = now.view.copy(items = items), stale = false)
    }

    fun answer(item: String, answer: JsonElement?) = act { replaceItems(api.answer(item, answer ?: JsonNull)) }

    fun dates(item: String, expiresOn: String?, issuedOn: String?, setExpires: Boolean, setIssued: Boolean) =
        act { replaceItems(api.dates(item, expiresOn, issuedOn, setExpires, setIssued)) }

    fun unavailable(item: String, note: String) = act { api.unavailable(item, note.trim()); load() }

    fun found(item: String) = act { api.found(item); load() }

    fun send(note: String) = act { api.note(note.trim()); load() }

    fun removeFile(id: String) = act { api.deleteFile(id); load() }

    /** Puts prepared files in the queue and starts sending. The prepared copies are removed. */
    fun add(item: String, files: List<Prepared>) {
        var error: String? = null
        for (f in files) {
            try {
                f.file.inputStream().use { queue.add(item, f.name, it) }
            } catch (e: ApiError) {
                error = e.code
            } finally {
                f.file.delete()
            }
        }
        acting.value = Action(error = error)
        kick()
    }

    fun retry(id: String) {
        queue.retry(id)
        kick()
    }

    fun drop(id: String) = queue.remove(id)

    /** Ends the session on this phone and the server's copy, and drops what had not been sent. */
    fun leave() {
        scope.launch {
            runCatching { api.clientLogout() }
            session.end()
        }
    }

    private fun act(block: suspend () -> Unit) {
        acting.value = Action(busy = true)
        scope.launch {
            try {
                block()
                acting.value = Action()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError.Other) {
                if (e.status == 404 && flow.value is ClientState.Ready) {
                    // the link went while the page was open
                    queue.forget()
                    flow.value = ClientState.Gone
                    acting.value = Action()
                } else {
                    acting.value = Action(error = e.code)
                }
            } catch (e: ApiError) {
                acting.value = Action(error = e.code)
            }
        }
    }

    fun clearError() {
        if (!acting.value.busy) acting.value = Action()
    }
}
