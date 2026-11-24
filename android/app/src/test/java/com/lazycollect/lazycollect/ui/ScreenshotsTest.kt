package com.lazycollect.lazycollect.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import com.lazycollect.lazycollect.net.Device
import com.lazycollect.lazycollect.net.Firm
import com.lazycollect.lazycollect.net.FirmState
import com.lazycollect.lazycollect.net.Me
import com.lazycollect.lazycollect.net.Note
import com.lazycollect.lazycollect.net.NoteThread
import com.lazycollect.lazycollect.net.RequestCounts
import com.lazycollect.lazycollect.net.RequestDetail
import com.lazycollect.lazycollect.net.RequestFile
import com.lazycollect.lazycollect.net.RequestItem
import com.lazycollect.lazycollect.net.RequestRow
import com.lazycollect.lazycollect.requests.PreviewState
import com.lazycollect.lazycollect.requests.RequestState
import com.lazycollect.lazycollect.requests.RequestsState
import com.lazycollect.lazycollect.requests.Shown
import com.lazycollect.lazycollect.net.User
import com.lazycollect.lazycollect.shell.Action
import com.lazycollect.lazycollect.shell.DevicesState
import com.lazycollect.lazycollect.shell.FirmState as SetupState
import com.lazycollect.lazycollect.signin.SignInState
import com.lazycollect.lazycollect.signin.Step
import java.io.File
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Renders the screens with fixed data, light and dark. The PNGs are written only by Roborazzi's record task:
 * gradlew recordRoborazziDebug -Pcollect.shotsDir=<folder>. A plain test run still renders every screen.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w393dp-h852dp-xxhdpi", application = android.app.Application::class)
class ScreenshotsTest {
    @get:Rule
    val compose = createComposeRule()

    private val noon = 1_760_000_000_000L
    private val day = 86_400_000L

    private fun capture(name: String, content: @Composable () -> Unit) {
        val dark = mutableStateOf(false)
        compose.setContent { LazyCollectTheme(dark = dark.value, content = content) }
        for (night in listOf(false, true)) {
            dark.value = night
            compose.waitForIdle()
            compose.onRoot().captureRoboImage(File(System.getProperty("collect.shotsDir") ?: "build/shots", "$name-${if (night) "dark" else "light"}.png").path)
        }
    }

    private fun me(
        role: String = "owner",
        name: String? = "Maple Tax Services",
        status: String = "active",
        usable: Boolean = true,
        closedAt: Long? = null,
        pastDueSince: Long? = null,
        trialEndsAt: Long? = null,
        periodEnd: Long? = null,
        cancel: Boolean = false,
    ) = Me(
        User("u1", "aytu@example.com", null, role),
        FirmState("f1", name, "America/Toronto", status, trialEndsAt, periodEnd, pastDueSince, cancel, closedAt = closedAt, usable = usable),
    )

    private val devices = DevicesState(
        listOf(
            Device("s1", "Lazy Collect for Android", noon - 2 * day, noon, current = true),
            Device("s2", "Chrome on Windows", noon - 20 * day, noon - 3 * day),
            Device("s3", "Lazy Collect for Android", noon - 40 * day, noon - 30 * day),
        ),
    )

    @Test
    fun signInEmail() = capture("signin-email") { SignInScreen(SignInState(), SignInActions()) }

    @Test
    fun signInEmailError() = capture("signin-email-error") { SignInScreen(SignInState(email = "aytu@example", error = "invalid_email"), SignInActions()) }

    @Test
    fun signInCode() = capture("signin-code") { SignInScreen(SignInState(Step.Code, "aytu@example.com"), SignInActions()) }

    @Test
    fun signInCodeError() = capture("signin-code-error") { SignInScreen(SignInState(Step.Code, "aytu@example.com", error = "invalid"), SignInActions()) }

    @Test
    fun signInPasskey() = capture("signin-passkey") { SignInScreen(SignInState(Step.Passkey, "aytu@example.com", owner = true), SignInActions()) }

    @Test
    fun signInEnrol() = capture("signin-enrol") { SignInScreen(SignInState(Step.Enrol, "aytu@example.com"), SignInActions()) }

    @Test
    fun setupOwner() = capture("setup") {
        SetupScreen(SetupState(Firm(tz = "America/Toronto")), canEdit = true, onSave = {}, onRetry = {}, onSignOut = {})
    }

    @Test
    fun setupWithBusinessDetails() = capture("setup-business") {
        SetupScreen(SetupState(Firm("Maple Tax", "Maple Tax Services Inc.", "12 Front St\nToronto ON", "416 555 0100", "ON", "America/Toronto")), true, {}, {}, {})
    }

    @Test
    fun setupMember() = capture("setup-member") {
        SetupScreen(SetupState(Firm(tz = "America/Toronto")), canEdit = false, onSave = {}, onRetry = {}, onSignOut = {})
    }

    @Test
    fun closedOwner() = capture("closed") { ClosedScreen(me(closedAt = noon - 3 * day), noon, Action(), {}, {}) }

    @Test
    fun closedMember() = capture("closed-member") { ClosedScreen(me("member", closedAt = noon - 3 * day), noon, Action(), {}, {}) }

    @Test
    fun shell() = capture("shell") { ShellScreen(me(), false, DevicesState(), ShellActions()) }

    @Test
    fun shellWithBanner() = capture("shell-past-due") {
        ShellScreen(me(status = "past_due", pastDueSince = noon - 2 * day), false, DevicesState(), ShellActions())
    }

    @Test
    fun settings() = capture("settings") { ShellScreen(me(), false, devices, ShellActions(), start = "settings", now = noon) }

    @Test
    fun licences() = capture("licences") { ShellScreen(me(), false, devices, ShellActions(), start = "settings/licences", now = noon) }

    @Test
    fun settingsTrial() = capture("settings-trial") {
        ShellScreen(me(status = "trialing", trialEndsAt = noon + 9 * day), false, devices, ShellActions(), start = "settings", now = noon)
    }

    @Test
    fun settingsSubscribed() = capture("settings-subscribed") {
        ShellScreen(me(periodEnd = noon + 20 * day), false, devices, ShellActions(), start = "settings", now = noon)
    }

    @Test
    fun settingsPastDue() = capture("settings-past-due") {
        ShellScreen(me(status = "past_due", pastDueSince = noon - 2 * day), false, devices, ShellActions(), start = "settings", now = noon)
    }

    @Test
    fun settingsMemberWithEndedPlan() = capture("settings-member-ended") {
        ShellScreen(me("member", status = "canceled", usable = false), false, devices, ShellActions(), start = "settings", now = noon)
    }

    private fun row(id: String, client: String, title: String, deadline: Long, submitted: Int = 0, unavailable: Int = 0, unanswered: Int = 0, expiring: Int = 0) =
        RequestRow(id, "c-$id", client, title, deadline, "open", empty = 2, submitted = submitted, approved = 1, unavailable = unavailable, unanswered = unanswered, expiring = expiring, expiringOn = if (expiring > 0) "2027-01-15" else null)

    private val requestCounts = RequestCounts(all = 14, toReview = 3, waiting = 6, expiring = 1, overdue = 2, dueSoon = 4)

    private val requestRows = listOf(
        row("r1", "Ana Silva", "Study permit extension", noon + 3 * day, submitted = 2, unanswered = 1),
        row("r2", "Maple Bakery Ltd.", "T2 year-end 2025", noon - 2 * day, unavailable = 1),
        row("r3", "Kofi Mensah", "Express Entry profile", noon + 20 * day, submitted = 1, expiring = 1),
    )

    @Composable
    private fun Page(content: @Composable () -> Unit) = Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface, content = content)

    @Test
    fun requestsList() = capture("requests") {
        Page { RequestsScreen(RequestsState(rows = requestRows, counts = requestCounts, next = 50), "America/Toronto", RequestsActions(), noon) }
    }

    @Test
    fun requestsListEmptyTab() = capture("requests-empty-tab") {
        Page { RequestsScreen(RequestsState(view = "overdue", rows = emptyList(), counts = requestCounts), "America/Toronto", RequestsActions(), noon) }
    }

    @Test
    fun requestsFirstRun() = capture("requests-first-run") {
        Page { RequestsScreen(RequestsState(rows = emptyList(), counts = RequestCounts()), "America/Toronto", RequestsActions(), noon) }
    }

    private val passport = RequestFile("f1", "passport-page.jpg", 1_400_000, "image/jpeg", noon - day)

    private val request = RequestDetail(
        "r1", "c1", "Study permit extension", "Please send clear photos of every page.", noon + 3 * day, "open", sentAt = noon - 5 * day, firstOpenedAt = noon - 4 * day, remindersOn = true,
        items = listOf(
            RequestItem("i1", "Passport", required = true, status = "submitted", files = listOf(passport, RequestFile("f2", "passport-cover.pdf", 320_000, "application/pdf", noon - day))),
            RequestItem("i2", "Letter of acceptance", required = true, status = "rejected", rejectReasons = listOf("blurry", "cut_off"), rejectNote = "The bottom edge is missing.", files = listOf(RequestFile("f3", "loa.jpg", 900_000, "image/jpeg", noon - 2 * day, sentBackAt = noon - day))),
            RequestItem("i3", "Proof of funds", required = true, status = "unavailable", unavailableNote = "My bank only sends paper statements."),
            RequestItem("i4", "Have you studied in Canada before?", required = true, status = "submitted", kind = "yesno", answer = kotlinx.serialization.json.JsonPrimitive("yes")),
            RequestItem("i5", "Study permit", required = false, status = "approved", expiryRule = "expiry", expiresOn = "2027-03-31", expiryFlag = "soon", files = listOf(RequestFile("f4", "permit.pdf", 210_000, "application/pdf", noon - 3 * day))),
        ),
    )

    private val thread = NoteThread(listOf(Note("n1", "client", "Is a phone photo fine for the passport?", noon - 2 * day), Note("n2", "user", "Yes, as long as all four corners show.", noon - day)), unanswered = 0)

    @Test
    fun requestDetail() = capture("request") {
        Page { RequestScreen(RequestState(request, "Ana Silva", thread = thread), PreviewState(), me(), false, RequestActions(), noon) }
    }

    @Test
    fun requestDetailWithLinkAndPlanEnded() = capture("request-link-plan-ended") {
        Page {
            RequestScreen(RequestState(request, "Ana Silva", thread = thread, link = "https://collect.alazy.app/c/ca_Zm9yLXRoZS1zY3JlZW5zaG90"), PreviewState(), me(status = "canceled", usable = false), true, RequestActions(), noon)
        }
    }

    @Test
    fun requestDetailError() = capture("request-error") {
        Page { RequestScreen(RequestState(error = null, loadError = "network"), PreviewState(), me(), false, RequestActions(), noon) }
    }

    @Test
    fun viewerWithAPicture() = capture("viewer") {
        val bitmap = remember {
            android.graphics.Bitmap.createBitmap(600, 400, android.graphics.Bitmap.Config.ARGB_8888).also { it.eraseColor(android.graphics.Color.rgb(230, 220, 200)) }
        }
        val files = request.items.flatMap { item -> item.files.map { item to it } }
        Page {
            ViewerScreen(files, 0, PreviewState(passport, Shown.Image(bitmap, File("passport-page.jpg"))), true, false, null, RequestActions(), {}, {}, true, false)
        }
    }

    @Test
    fun viewerWithATypeItCannotShow() = capture("viewer-other") {
        val heic = RequestFile("f9", "photo.heic", 2_000_000, "image/heic", noon)
        val item = RequestItem("i9", "Photo ID", required = true, status = "approved", files = listOf(heic))
        Page { ViewerScreen(listOf(item to heic), 0, PreviewState(heic, Shown.Other(File("photo.heic"))), true, false, null, RequestActions(), {}, {}, true, false) }
    }
}
