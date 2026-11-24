package com.lazycollect.lazycollect.ui

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.compose.runtime.CompositionLocalProvider
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.lazycollect.lazycollect.client.ClientState
import com.lazycollect.lazycollect.net.ClientItem
import com.lazycollect.lazycollect.net.ClientView
import com.lazycollect.lazycollect.shell.Action
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w393dp-h852dp-xxhdpi", application = android.app.Application::class)
class ClientAnswerTest {
    @get:Rule
    val compose = createComposeRule()

    private val sent = ArrayList<Pair<String, JsonElement?>>()
    private val actions = ClientActions(answer = { id, a -> sent += id to a })
    private val view = ClientView(
        firmName = "Firm", title = "Study permit", deadline = 1_800_000_000_000, status = "open", expiresAt = 1_900_000_000_000,
        items = listOf(ClientItem(id = "q1", label = "Employer", required = true, status = "empty", kind = "text")),
    )

    @Test
    fun theDoneKeySavesTheTextOnceEvenWhenFocusLeavesAfterwards() {
        compose.setContent { ClientRoot(ClientState.Ready(view), Action(), emptyList(), 0, actions) }
        compose.onNodeWithText("Your answer").performTextInput("Acme")
        compose.onNodeWithText("Your answer").performImeAction()
        compose.waitForIdle()
        assertEquals(listOf<Pair<String, JsonElement?>>("q1" to JsonPrimitive("Acme")), sent)
    }

    @Test
    fun theNoteStaysUntilTheServerHasIt() {
        val count = androidx.compose.runtime.mutableIntStateOf(0)
        compose.setContent { ClientRoot(ClientState.Ready(view), Action(), emptyList(), 0, actions, notesSent = count.intValue) }
        compose.onNodeWithText("Your message").performScrollTo().performTextInput("Hello")
        compose.onNodeWithText("Send message").performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Hello").assertExists()
        compose.runOnUiThread { count.intValue = 1 }
        compose.waitForIdle()
        compose.onNodeWithText("Hello").assertDoesNotExist()
    }

    @Test
    fun leavingTheAppSavesWhatWasTyped() {
        val owner = object : LifecycleOwner {
            val registry = LifecycleRegistry.createUnsafe(this).also { it.currentState = Lifecycle.State.RESUMED }
            override val lifecycle: Lifecycle get() = registry
        }
        compose.setContent {
            CompositionLocalProvider(LocalLifecycleOwner provides owner) { ClientRoot(ClientState.Ready(view), Action(), emptyList(), 0, actions) }
        }
        compose.onNodeWithText("Your answer").performTextInput("Acme")
        compose.runOnUiThread { owner.registry.currentState = Lifecycle.State.CREATED }
        compose.waitForIdle()
        assertEquals(1, sent.size)
        compose.runOnUiThread { owner.registry.currentState = Lifecycle.State.STARTED }
        compose.runOnUiThread { owner.registry.currentState = Lifecycle.State.CREATED }
        compose.waitForIdle()
        assertEquals(1, sent.size)
    }

    @Test
    fun aFailedSaveIsSentAgainOnTheNextBlurEvenWhenItFailedAtOnce() {
        val failures = androidx.compose.runtime.mutableIntStateOf(0)
        compose.setContent { ClientRoot(ClientState.Ready(view), Action(), emptyList(), 0, actions, answersFailed = failures.intValue) }
        compose.onNodeWithText("Your answer").performTextInput("Acme")
        compose.onNodeWithText("Your answer").performImeAction()
        compose.waitForIdle()
        assertEquals(1, sent.size)
        compose.runOnUiThread { failures.intValue = 1 }
        compose.onNodeWithText("Your answer").performImeAction()
        compose.waitForIdle()
        assertEquals(2, sent.size)
    }
}
