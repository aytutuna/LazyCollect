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

const val UNREADABLE = "file_unreadable"

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
    private val online: StateFlow<Boolean> = MutableStateFlow(true),
    /** Removes what the phone kept for the checklist besides the queue: scanned pages and prepared copies. */
    private val wipe: () -> Unit = {},
    private val kick: () -> Unit,
) {
    private val flow = MutableStateFlow<ClientState>(ClientState.Loading)
    private val acting = MutableStateFlow(Action())
    private val gone = MutableStateFlow(0)
    private val notes = MutableStateFlow(0)

    val state: StateFlow<ClientState> get() = flow
    val action: StateFlow<Action> get() = acting
    val jobs get() = queue.jobs
    val progress get() = queue.progress
    val connected: StateFlow<Boolean> get() = online

    /** Counts the notes the server has taken, so the box they were typed in can be emptied only then. */
    val notesSent: StateFlow<Int> get() = notes

    /** How many waiting files were dropped because their item left the list; shown once. */
    val dropped: StateFlow<Int> get() = gone

    fun acknowledgeDropped() {
        gone.value = 0
    }

    init {
        scope.launch {
            var previous: String? = null
            session.token.collect {
                if (it == null || (previous != null && previous != it)) forgetAll()
                if (it != null) {
                    flow.value = ClientState.Loading
                    load()
                }
                previous = it
            }
        }
        scope.launch {
            var waiting = queue.jobs.value.size
            queue.jobs.collect {
                // a file that went (or was dropped) changes what the checklist should show
                if (it.size < waiting && session.token.value != null) load()
                waiting = it.size
            }
        }
        scope.launch {
            var was = online.value
            online.collect {
                // coming back online sends what waited and refreshes a page that may have gone stale
                if (it && !was && session.token.value != null) {
                    load()
                    val fresh = (flow.value as? ClientState.Ready)?.stale == false
                    if (!fresh && queue.jobs.value.any { it.failed == null }) kick()
                }
                was = it
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
        act(reloadOnMissing = false) {
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
                forgetAll()
                flow.value = ClientState.Gone
            } else {
                fail(before, e)
            }
        } catch (e: ApiError) {
            fail(before, e)
        }
    }

    private fun forgetAll() {
        queue.forget()
        wipe()
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

    /** The professional's example for an item, or null when it cannot be had; nothing is kept. */
    suspend fun example(item: String): ByteArray? = try { api.example(item) } catch (e: ApiError) { null }

    fun send(note: String) = act {
        api.note(note.trim())
        notes.value++
        load()
    }

    fun removeFile(id: String) = act { api.deleteFile(id); load() }

    /** Puts prepared files in the queue and starts sending. The prepared copies are removed. */
    fun add(item: String, files: List<Prepared>) {
        var error: String? = null
        for (f in files) {
            try {
                f.file.inputStream().use { queue.add(item, f.name, it) }
            } catch (e: ApiError) {
                error = e.code
            } catch (e: IOException) {
                error = UNREADABLE
            } catch (e: SecurityException) {
                error = UNREADABLE
            } finally {
                f.file.delete()
            }
        }
        acting.value = Action(error = error)
        kick()
    }

    /** Tells the person a chosen file could not be read or prepared. */
    fun unreadable() {
        acting.value = Action(error = UNREADABLE)
    }

    fun retry(id: String) {
        queue.retry(id)
        kick()
    }

    fun drop(id: String) = queue.remove(id)

    /** Ends the session on this phone and the server's copy, and drops what had not been sent. */
    fun leave() {
        val old = session.token.value
        session.end()
        queue.forget()
        if (old != null) scope.launch { runCatching { api.clientLogout(old) } }
    }

    /** A 404 from a call on the checklist can be one item or file that went; [load] tells whether the link did. */
    private fun act(reloadOnMissing: Boolean = true, block: suspend () -> Unit) {
        acting.value = Action(busy = true)
        scope.launch {
            try {
                block()
                acting.value = Action()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError.Other) {
                if (e.status == 404 && reloadOnMissing && flow.value is ClientState.Ready) {
                    acting.value = Action()
                    load()
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
