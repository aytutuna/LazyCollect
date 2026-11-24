package com.lazycollect.lazycollect.ui

import com.lazycollect.lazycollect.R
import com.lazycollect.lazycollect.net.FirmState
import com.lazycollect.lazycollect.net.Me
import com.lazycollect.lazycollect.net.User
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PlanBannerTest {
    private val day = 86_400_000L

    private fun me(role: String, status: String, usable: Boolean, pastDueSince: Long? = null) =
        Me(User("u", "a@b.co", null, role), FirmState("f", "Firm", "America/Toronto", status, pastDueSince = pastDueSince, usable = usable))

    @Test
    fun aWorkingPlanHasNoBanner() {
        assertNull(planBanner(me("owner", "active", true), false))
        assertNull(planBanner(me("member", "trialing", true), false))
    }

    @Test
    fun anEndedPlanSaysWhoToAsk() {
        assertEquals(R.string.plan_ended to null, planBanner(me("owner", "canceled", false), false))
        assertEquals(R.string.plan_ended_member to null, planBanner(me("member", "canceled", false), false))
    }

    @Test
    fun aServerRefusalAloneEndsThePlan() {
        assertEquals(R.string.plan_ended to null, planBanner(me("owner", "active", true), true))
    }

    @Test
    fun aFailedPaymentGivesAGraceOfSevenDays() {
        assertEquals(R.string.plan_past_due to 10 * day + 7 * day, planBanner(me("owner", "past_due", true, 10 * day), false))
        assertEquals(R.string.plan_past_due_member to 10 * day + 7 * day, planBanner(me("member", "past_due", true, 10 * day), false))
    }

    @Test
    fun afterTheGraceTheBannerSaysItEnded() {
        assertEquals(R.string.plan_past_due_ended to null, planBanner(me("owner", "past_due", false, 10 * day), false))
        assertEquals(R.string.plan_past_due_ended_member to null, planBanner(me("member", "past_due", false, 10 * day), false))
    }
}
