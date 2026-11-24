package com.lazycollect.lazycollect.requests

import com.lazycollect.lazycollect.net.Api
import com.lazycollect.lazycollect.net.ApiError
import com.lazycollect.lazycollect.net.RequestCounts
import com.lazycollect.lazycollect.net.RequestRow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

val VIEWS = listOf("to_review", "waiting", "expiring", "overdue", "due_soon", "all")
val STATUSES = listOf("draft", "open", "complete", "expired", "closed")
val SORTS = listOf("newest", "deadline", "activity")

// the order that suits each tab until the person picks another
private fun sortFor(view: String) = when (view) {
    "to_review" -> "activity"
    "all" -> "newest"
    else -> "deadline"
}

fun RequestCounts.of(view: String) = when (view) {
    "to_review" -> toReview
    "waiting" -> waiting
    "expiring" -> expiring
    "overdue" -> overdue
    "due_soon" -> dueSoon
    else -> all
}

data class RequestsState(
    val view: String = "to_review",
    val status: String? = null,
    val query: String = "",
    val chosenSort: String? = null,
    /** Null until the first page has come. */
    val rows: List<RequestRow>? = null,
    val next: Int? = null,
    val counts: RequestCounts? = null,
    val loading: Boolean = false,
    val loadingMore: Boolean = false,
    val error: String? = null,
    val moreError: String? = null,
    /** A request was changed after the list was read. */
    val outdated: Boolean = false,
) {
    val sort get() = chosenSort ?: sortFor(view)
    val filtered get() = query.isNotEmpty() || status != null

    /** No request at all, and nothing typed or picked that could be hiding some. */
    val firstRun get() = rows != null && counts?.all == 0 && !filtered && !loading

    fun withSort(sort: String) = copy(chosenSort = sort)
    fun withView(view: String) = copy(view = view, chosenSort = null)
}

/** The Requests tab's list: the tabs and filters, a page at a time from the server. */
class RequestsModel(private val scope: CoroutineScope, private val api: Api) {
    private val flow = MutableStateFlow(RequestsState())
    private var job: Job? = null

    val state: StateFlow<RequestsState> get() = flow

    /** For a screen that is composed again with the list already there. */
    fun loadOnce() {
        val now = flow.value
        if ((now.rows == null || now.outdated) && !now.loading) refresh()
    }

    fun markOutdated() = flow.update { it.copy(outdated = true) }

    fun refresh() = fetch(0)

    fun show(view: String) {
        if (view == flow.value.view) return
        flow.update { it.withView(view) }
        refresh()
    }

    fun filter(status: String?) {
        if (status == flow.value.status) return
        flow.update { it.copy(status = status) }
        refresh()
    }

    fun sort(sort: String) {
        if (sort == flow.value.sort) return
        flow.update { it.withSort(sort) }
        refresh()
    }

    fun search(query: String) {
        val typed = query.trim().take(MAX_QUERY)
        if (typed == flow.value.query) return
        flow.update { it.copy(query = typed) }
        refresh()
    }

    fun loadMore() {
        val now = flow.value
        if (now.next == null || now.loadingMore || now.loading) return
        fetch(now.next)
    }

    fun reset() {
        job?.cancel()
        flow.value = RequestsState()
    }

    private fun fetch(offset: Int) {
        job?.cancel()
        val first = offset == 0
        flow.update { if (first) it.copy(loading = true, loadingMore = false, error = null, moreError = null, outdated = false) else it.copy(loadingMore = true, moreError = null) }
        val asked = flow.value
        job = scope.launch {
            try {
                val page = api.requests(asked.view, asked.sort, asked.status, null, asked.query, offset)
                flow.update {
                    it.copy(
                        rows = if (first) page.rows else it.rows.orEmpty() + page.rows,
                        next = page.next,
                        counts = page.counts ?: it.counts,
                        loading = false,
                        loadingMore = false,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                flow.update { if (first) it.copy(loading = false, error = e.code) else it.copy(loadingMore = false, moreError = e.code) }
            }
        }
    }
}

private const val MAX_QUERY = 100
