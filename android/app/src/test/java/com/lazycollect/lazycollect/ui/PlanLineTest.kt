package com.lazycollect.lazycollect.ui

import com.lazycollect.lazycollect.R
import com.lazycollect.lazycollect.net.FirmState
import org.junit.Assert.assertEquals
import org.junit.Test

class PlanLineTest {
    private val now = 1_760_000_000_000L
    private val day = 86_400_000L

    private fun firm(status: String, usable: Boolean = true, trialEndsAt: Long? = null, periodEnd: Long? = null, pastDueSince: Long? = null, cancel: Boolean = false, subscribed: Boolean = false) =
        FirmState("f", "Firm", "America/Toronto", status, trialEndsAt, periodEnd, pastDueSince, cancel, subscribed, usable = usable)

    @Test
    fun aTrialNamesItsEndAndWarnsWhenItIsNear() {
        assertEquals(R.string.plan_line_trial to now + 10 * day, planLine(firm("trialing", trialEndsAt = now + 10 * day), now))
        assertEquals(R.string.plan_line_trial_soon to now + day, planLine(firm("trialing", trialEndsAt = now + day), now))
    }

    @Test
    fun aTrialWithASubscriptionSaysWhatHappensAtTheEnd() {
        assertEquals(R.string.plan_line_trial_subscribed to now + 10 * day, planLine(firm("trialing", trialEndsAt = now + 10 * day, subscribed = true), now))
        assertEquals(R.string.plan_line_trial_cancelling to now + 10 * day, planLine(firm("trialing", trialEndsAt = now + 10 * day, subscribed = true, cancel = true), now))
    }

    @Test
    fun aTrialThatIsOverIsAnEndedPlan() {
        assertEquals(R.string.plan_line_ended to null, planLine(firm("trialing", trialEndsAt = now - day), now))
        assertEquals(R.string.plan_line_ended to null, planLine(firm("canceled"), now))
    }

    @Test
    fun aSubscriptionNamesItsRenewalOrItsEnd() {
        assertEquals(R.string.plan_line_active to now + 20 * day, planLine(firm("active", periodEnd = now + 20 * day, subscribed = true), now))
        assertEquals(R.string.plan_line_cancelling to now + 20 * day, planLine(firm("active", periodEnd = now + 20 * day, subscribed = true, cancel = true), now))
    }

    @Test
    fun aFailedPaymentHasAGraceDate() {
        assertEquals(R.string.plan_line_past_due to now - 2 * day + GRACE_MS, planLine(firm("past_due", pastDueSince = now - 2 * day), now))
        assertEquals(R.string.plan_line_past_due_ended to null, planLine(firm("past_due", usable = false, pastDueSince = now - 9 * day), now))
    }
}
