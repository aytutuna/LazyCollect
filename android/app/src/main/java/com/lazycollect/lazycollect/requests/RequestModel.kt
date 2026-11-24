package com.lazycollect.lazycollect.requests

import com.lazycollect.lazycollect.net.Api
import com.lazycollect.lazycollect.net.ApiError
import com.lazycollect.lazycollect.net.NoteThread
import com.lazycollect.lazycollect.net.RequestDetail
import com.lazycollect.lazycollect.net.RequestItem
import com.lazycollect.lazycollect.net.ReviewBody
import com.lazycollect.lazycollect.net.UnavailableDecision
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

const val MAX_REJECT_NOTE = 500
const val MAX_REPLY = 2000

private val FILE_REASONS = listOf("blurry", "cut_off", "glare", "dark", "wrong_document", "wrong_period", "expired", "wrong_person", "pages_missing", "locked_pdf", "other")
private val QUESTION_REASONS = listOf("wrong_period", "wrong_person", "other")

// the same lists as the server's; it refuses anything else
fun reasonsFor(kind: String) = if (kind == "file") FILE_REASONS else QUESTION_REASONS

/** What a send-back still lacks. */
enum class Need { Reason, Note, OtherNote }

/** A document needs a reason; a question can go back with only a note, and "other" is explained by the note. */
fun rejectNeed(kind: String, reasons: Set<String>, note: String): Need? = when {
    "other" in reasons && note.isBlank() -> Need.OtherNote
    reasons.isEmpty() && kind == "file" -> Need.Reason
    reasons.isEmpty() && note.isBlank() -> Need.Note
    else -> null
}

data class RequestState(
    val request: RequestDetail? = null,
    val clientName: String = "",
    /** Why the first load failed; set only while there is nothing to show. */
    val loadError: String? = null,
    /** A refresh failed and what is shown may be out of date. */
    val stale: Boolean = false,
    val thread: NoteThread? = null,
    val link: String? = null,
    /** "emailed", "email_failed" or "missing": what happened when the link was made or looked up. */
    val linkNote: String? = null,
    val reminded: Boolean = false,
    /** The server's word on the email that told the client about a reply (sent, recent, no_email ...). */
    val replied: String? = null,
    val busy: Boolean = false,
    val error: String? = null,
)

/** One request: what the client sent, the review of it, the link and the thread of messages. */
class RequestModel(parent: CoroutineScope, private val api: Api, private val id: String, private val changed: () -> Unit = {}) {
    private val scope = CoroutineScope(parent.coroutineContext + SupervisorJob(parent.coroutineContext[Job]))
    private val flow = MutableStateFlow(RequestState())
    private var loading: Job? = null

    val state: StateFlow<RequestState> get() = flow

    fun load() {
        loading?.cancel()
        loading = scope.launch {
            try {
                val request = api.request(id)
                flow.update { it.copy(request = request, loadError = null, stale = false) }
                if (flow.value.clientName.isEmpty()) lookUpClient(request.clientId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                flow.update { if (it.request == null) it.copy(loadError = e.code) else it.copy(stale = true) }
            }
            loadThread()
        }
    }

    // the detail has no client name; a list filtered to the client says it
    private suspend fun lookUpClient(clientId: String) {
        try {
            api.requests("all", "newest", null, clientId, "", 0).client?.let { c -> flow.update { it.copy(clientName = c.name) } }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            // the name is only a heading
        }
    }

    private suspend fun loadThread() {
        try {
            val thread = api.thread(id)
            flow.update { it.copy(thread = thread) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            // the thread keeps what it had
        }
    }

    fun approve(item: RequestItem) = review(item, ReviewBody("approve", item.files.map { it.id }, item.answerAt))

    /** Does nothing while [rejectNeed] says something is missing, as the form cannot be sent then either. */
    fun reject(item: RequestItem, reasons: Set<String>, note: String) {
        if (rejectNeed(item.kind, reasons, note) != null) return
        val ordered = reasonsFor(item.kind).filter { it in reasons }
        review(item, ReviewBody("reject", item.files.map { it.id }, item.answerAt, ordered, note.trim().ifEmpty { null }))
    }

    private fun review(item: RequestItem, body: ReviewBody) = act { api.review(id, item.id, body) }

    /** Accepts that the client does not have the item. */
    fun waive(item: RequestItem) = act { api.unavailable(id, item.id, UnavailableDecision("accept")) }

    fun askAgain(item: RequestItem, note: String) {
        if (note.isBlank()) return
        act { api.unavailable(id, item.id, UnavailableDecision("ask", note.trim())) }
    }

    fun remind() {
        flow.update { it.copy(reminded = false) }
        act { api.remind(id); flow.update { it.copy(reminded = true) } }
    }

    fun showLink() = act {
        val found = api.link(id)
        flow.update { it.copy(link = found.url, linkNote = if (found.url == null) "missing" else null) }
    }

    fun makeLink(email: Boolean) = act {
        val made = api.makeLink(id, email)
        flow.update { it.copy(link = made.url, linkNote = if (made.emailed) "emailed" else if (made.emailFailed) "email_failed" else null) }
    }

    fun reply(body: String) {
        val text = body.trim().take(MAX_REPLY)
        if (text.isEmpty()) return
        act {
            val sent = api.reply(id, text)
            flow.update { it.copy(replied = sent.email) }
            loadThread()
        }
    }

    fun close() = scope.cancel()

    private fun act(block: suspend () -> Unit) {
        if (flow.value.busy) return
        flow.update { it.copy(busy = true, error = null, replied = null) }
        scope.launch {
            try {
                block()
                flow.update { it.copy(busy = false) }
                changed()
                refresh()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                flow.update { it.copy(busy = false, error = e.code) }
                // a decision on something that changed meanwhile is refused; what is shown is old
                if (e is ApiError.Conflict) refresh()
            }
        }
    }

    private suspend fun refresh() {
        try {
            val request = api.request(id)
            flow.update { it.copy(request = request, stale = false) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            flow.update { it.copy(stale = true) }
        }
    }
}
