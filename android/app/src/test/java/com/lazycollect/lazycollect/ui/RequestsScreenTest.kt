package com.lazycollect.lazycollect.ui

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import com.lazycollect.lazycollect.net.FirmState
import com.lazycollect.lazycollect.net.Me
import com.lazycollect.lazycollect.net.Note
import com.lazycollect.lazycollect.net.NoteThread
import com.lazycollect.lazycollect.net.RequestCounts
import com.lazycollect.lazycollect.net.RequestDetail
import com.lazycollect.lazycollect.net.RequestFile
import com.lazycollect.lazycollect.net.RequestItem
import com.lazycollect.lazycollect.net.RequestRow
import com.lazycollect.lazycollect.net.User
import com.lazycollect.lazycollect.requests.PreviewState
import com.lazycollect.lazycollect.requests.RequestState
import com.lazycollect.lazycollect.requests.RequestsState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w393dp-h852dp-xxhdpi", application = android.app.Application::class)
class RequestsScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val noon = 1_760_000_000_000L
    private val day = 86_400_000L

    private fun row(id: String, client: String, title: String, submitted: Int = 0, deadline: Long = noon + 3 * day) =
        RequestRow(id, "c-$id", client, title, deadline, "open", empty = 2, submitted = submitted, approved = 1)

    private val counts = RequestCounts(all = 3, toReview = 2, waiting = 1, dueSoon = 1)

    private fun list(vararg rows: RequestRow, view: String = "to_review", query: String = "", next: Int? = null) =
        RequestsState(view = view, query = query, rows = rows.toList(), counts = counts, next = next)

    private fun me(role: String = "owner") = Me(User("u1", "a@b.co", null, role), FirmState("f1", "Firm", "America/Toronto", "active", usable = true))

    private fun file(id: String, name: String = "passport.jpg") = RequestFile(id, name, 1_500_000, "image/jpeg", noon)

    private fun item(id: String, status: String = "submitted", kind: String = "file", files: List<RequestFile> = listOf(file("f-$id")), label: String = "Passport") =
        RequestItem(id, label, required = true, status = status, kind = kind, files = files)

    private fun request(vararg items: RequestItem, status: String = "open", sentAt: Long? = noon - day) =
        RequestDetail("r1", "c1", "Study permit", null, noon + 3 * day, status, sentAt = sentAt, items = items.toList())

    private fun detail(
        request: RequestDetail,
        planEnded: Boolean = false,
        state: RequestState = RequestState(request, "Ana Silva"),
        actions: RequestActions = RequestActions(),
        role: String = "owner",
    ) = compose.setContent {
        LazyCollectTheme { RequestScreen(state, PreviewState(), me(role), planEnded, actions, noon) }
    }

    @Test
    fun theListShowsWhatNeedsAttentionOnEachRequest() {
        compose.setContent {
            LazyCollectTheme { RequestsScreen(list(row("r1", "Ana Silva", "Study permit", submitted = 2)), "America/Toronto", RequestsActions(), noon) }
        }
        compose.onNodeWithText("Ana Silva").assertExists()
        compose.onNodeWithText("Study permit").assertExists()
        compose.onNodeWithText("2 to review").assertExists()
        compose.onNodeWithText("Received 3 of 5").assertExists()
        compose.onNodeWithText("In 3 days", substring = true).assertExists()
        compose.onNodeWithText("To review  2").assertExists()
    }

    @Test
    fun aTapOpensTheRequestAndATabAsksForItsView() {
        var opened: String? = null
        var shown: String? = null
        compose.setContent {
            LazyCollectTheme {
                RequestsScreen(list(row("r1", "Ana Silva", "Study permit")), "America/Toronto", RequestsActions(show = { shown = it }, open = { opened = it }), noon)
            }
        }
        compose.onNodeWithText("Study permit").performClick()
        assertEquals("r1", opened)
        compose.onNodeWithText("Waiting on client  1").performClick()
        assertEquals("waiting", shown)
    }

    @Test
    fun theListAsksForMoreOnlyWhenThereIsAnotherPage() {
        var more = 0
        compose.setContent {
            LazyCollectTheme { RequestsScreen(list(row("r1", "Ana", "A"), next = 50), "America/Toronto", RequestsActions(more = { more++ }), noon) }
        }
        compose.onNodeWithText("Showing 1 of 2").assertExists()
        compose.onNodeWithText("Load more").performScrollTo().performClick()
        assertEquals(1, more)
    }

    @Test
    fun anEmptyTabSaysSoAndOffersAll() {
        var shown: String? = null
        compose.setContent {
            LazyCollectTheme { RequestsScreen(list(view = "overdue"), "America/Toronto", RequestsActions(show = { shown = it }), noon) }
        }
        compose.onNodeWithText("Nothing is overdue.").assertExists()
        compose.onNodeWithText("Show all requests").performClick()
        assertEquals("all", shown)
    }

    @Test
    fun aSearchWithNoMatchSaysSo() {
        compose.setContent {
            LazyCollectTheme { RequestsScreen(list(query = "zzz"), "America/Toronto", RequestsActions(), noon) }
        }
        compose.onNodeWithText("No requests match.").assertExists()
    }

    @Test
    fun anAccountWithNoRequestsGetsTheFirstRunNote() {
        compose.setContent {
            LazyCollectTheme { RequestsScreen(RequestsState(rows = emptyList(), counts = RequestCounts()), "America/Toronto", RequestsActions(), noon) }
        }
        compose.onNodeWithText("No requests yet").assertExists()
        compose.onNodeWithText("To review").assertDoesNotExist()
    }

    @Test
    fun aFailedFirstLoadOffersARetry() {
        var tried = 0
        compose.setContent {
            LazyCollectTheme { RequestsScreen(RequestsState(error = "network"), "America/Toronto", RequestsActions(refresh = { tried++ }), noon) }
        }
        compose.onNodeWithText("Could not reach the server. Check your connection and try again.").assertExists()
        compose.onNodeWithText("Try again").performClick()
        assertEquals(1, tried)
    }

    @Test
    fun approvingIsOneTap() {
        var approved: String? = null
        detail(request(item("i1")), actions = RequestActions(approve = { approved = it.id }))
        compose.onNodeWithText("Approve").performScrollTo().performClick()
        assertEquals("i1", approved)
    }

    @Test
    fun sendingBackNeedsAReasonForADocument() {
        var sent: Pair<Set<String>, String>? = null
        detail(request(item("i1")), actions = RequestActions(reject = { _, reasons, note -> sent = reasons to note }))
        compose.onNodeWithText("Send back").performScrollTo().performClick()
        compose.onNodeWithText("Pick at least one reason.").assertExists()
        compose.onNodeWithText("Blurry or hard to read").performScrollTo().performClick()
        compose.onNodeWithText("Pick at least one reason.").assertDoesNotExist()
        compose.onNodeWithText("Other").performScrollTo().performClick()
        compose.onNodeWithText("Add a note that says what is wrong.").assertExists()
        compose.onNodeWithText("Note for the client").performScrollTo().performTextInput("Retake it")
        compose.onNodeWithText("Add a note that says what is wrong.").assertDoesNotExist()
        compose.onNodeWithText("Send back").performScrollTo().performClick()
        assertEquals(setOf("blurry", "other") to "Retake it", sent)
    }

    @Test
    fun aQuestionOnlyOffersTheReasonsThatFit() {
        detail(request(item("q1", kind = "text", files = emptyList(), label = "Which year?")))
        compose.onNodeWithText("Send back").performScrollTo().performClick()
        compose.onNodeWithText("Wrong year or period").assertExists()
        compose.onNodeWithText("Blurry or hard to read").assertDoesNotExist()
        compose.onNodeWithText("Add a note, or pick a reason.").assertExists()
    }

    @Test
    fun aClosedRequestCannotBeReviewedOrReplied() {
        detail(request(item("i1"), status = "closed"))
        compose.onNodeWithText("Approve").assertDoesNotExist()
        compose.onNodeWithText("Send reply").assertDoesNotExist()
        compose.onNodeWithText("Client link").assertDoesNotExist()
    }

    @Test
    fun whatTheClientSaidAboutAnItemCanBeAcceptedOrAskedAgain() {
        var waived: String? = null
        var asked: Pair<String, String>? = null
        val gone = RequestItem("i2", "T4", required = true, status = "unavailable", unavailableNote = "Employer closed")
        detail(request(gone), actions = RequestActions(waive = { waived = it.id }, askAgain = { i, note -> asked = i.id to note }))
        compose.onNodeWithText("Reason: Employer closed").assertExists()
        compose.onNodeWithText("Accept").performScrollTo().performClick()
        assertEquals("i2", waived)
        compose.onNodeWithText("Ask again").performScrollTo().performClick()
        compose.onNodeWithText("Send note").assertIsNotEnabled()
        compose.onNodeWithText("What should the client do instead?").performTextInput("Ask HR")
        compose.onNodeWithText("Send note").performScrollTo().assertIsEnabled().performClick()
        assertEquals("i2" to "Ask HR", asked)
    }

    @Test
    fun anEndedPlanPausesNewLinksButNotReview() {
        detail(request(item("i1"), sentAt = null), planEnded = true)
        compose.onNodeWithText("Create link").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("New links are paused while the plan has ended.").assertExists()
        compose.onNodeWithText("Approve").performScrollTo().assertIsEnabled()
    }

    @Test
    fun aWorkingPlanCanMakeALink() {
        var made: Boolean? = null
        detail(request(item("i1"), sentAt = null), actions = RequestActions(makeLink = { made = it }))
        compose.onNodeWithText("Create link").performScrollTo().performClick()
        compose.onNodeWithText("Email the link to the client").performClick()
        compose.onAllNodesWithTextButton("Create link").onLast().performClick()
        assertEquals(true, made)
    }

    @Test
    fun theRefusalOfAnActionIsShownInThePlansWords() {
        val state = RequestState(request(item("i1")), "Ana Silva", error = "plan")
        detail(request(item("i1")), state = state, role = "member")
        compose.onNodeWithText("The plan has ended. Ask the account owner to subscribe.").assertExists()
    }

    @Test
    fun theThreadShowsBothSidesAndTakesAReply() {
        var replied: String? = null
        val thread = NoteThread(listOf(Note("n1", "client", "Is a scan fine?", noon), Note("n2", "user", "Yes.", noon + 1000)), unanswered = 0)
        detail(request(item("i1")), state = RequestState(request(item("i1")), "Ana Silva", thread = thread), actions = RequestActions(reply = { replied = it }))
        compose.onNodeWithText("Is a scan fine?").performScrollTo().assertExists()
        compose.onNodeWithText("Send reply").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("Reply to the client").performScrollTo().performTextInput("Thanks")
        compose.onNodeWithText("Send reply").assertIsEnabled().performClick()
        assertEquals("Thanks", replied)
    }

    @Test
    fun theLinkIsShownWithCopyAndShare() {
        detail(request(item("i1")), state = RequestState(request(item("i1")), "Ana Silva", link = "https://collect.alazy.app/c/abc"))
        compose.onNodeWithText("https://collect.alazy.app/c/abc").performScrollTo().assertExists()
        compose.onNodeWithText("Copy link").assertExists()
        compose.onNodeWithText("Share link").assertExists()
        compose.onNodeWithText("Remind now").assertIsEnabled()
    }

    @Test
    fun aFileOpensTheViewer() {
        var opened: String? = null
        detail(request(item("i1")), actions = RequestActions(preview = { opened = it.id }))
        compose.onNodeWithText("passport.jpg (1.4 MB)").performScrollTo().performClick()
        compose.waitForIdle()
        assertEquals("f-i1", opened)
        assertTrue(compose.onNodeWithText("File 1 of 1").isDisplayedOrExists())
    }

    private fun androidx.compose.ui.test.SemanticsNodeInteraction.isDisplayedOrExists() = runCatching { assertExists(); true }.getOrDefault(false)

    private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onAllNodesWithTextButton(text: String) =
        onAllNodes(androidx.compose.ui.test.hasText(text) and androidx.compose.ui.test.hasClickAction())
}
