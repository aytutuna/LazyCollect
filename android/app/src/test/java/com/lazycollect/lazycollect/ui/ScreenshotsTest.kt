package com.lazycollect.lazycollect.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import com.lazycollect.lazycollect.net.Device
import com.lazycollect.lazycollect.net.Firm
import com.lazycollect.lazycollect.net.FirmState
import com.lazycollect.lazycollect.net.Me
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
}
