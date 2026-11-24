package com.lazycollect.lazycollect.ui

import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.lazycollect.lazycollect.net.FirmState
import com.lazycollect.lazycollect.net.Me
import com.lazycollect.lazycollect.net.User
import com.lazycollect.lazycollect.shell.DevicesState
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], application = android.app.Application::class)
class ShellNavigationTest {
    @get:Rule
    val compose = createComposeRule()

    private fun me(role: String) = Me(User("u1", "a@b.co", null, role), FirmState("f1", "Firm", "America/Toronto", "active", usable = true))

    @Test
    fun theSettingsTabLeavesTheLicences() {
        compose.setContent { LazyCollectTheme { ShellScreen(me("owner"), false, DevicesState(), ShellActions(), start = "settings") } }
        compose.onNodeWithText("Open-source licences").performScrollTo().performClick()
        compose.mainClock.advanceTimeBy(1000)
        compose.onNodeWithText("Account").assertDoesNotExist()
        compose.onNode(hasText("Settings") and isSelectable()).performClick()
        compose.mainClock.advanceTimeBy(1000)
        compose.onNodeWithText("Account").assertExists()
    }

    @Test
    fun onlyMembersAreToldTheOwnerChangesThePlan() {
        compose.setContent { LazyCollectTheme { ShellScreen(me("member"), false, DevicesState(), ShellActions(), start = "settings") } }
        compose.onNodeWithText("Only the owner of the account can change the plan.").assertExists()
    }

    @Test
    fun theOwnerIsNotTold() {
        compose.setContent { LazyCollectTheme { ShellScreen(me("owner"), false, DevicesState(), ShellActions(), start = "settings") } }
        compose.onNodeWithText("Only the owner of the account can change the plan.").assertDoesNotExist()
    }
}
