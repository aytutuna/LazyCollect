package com.lazycollect.lazycollect.client

import com.lazycollect.lazycollect.net.ClientItem
import com.lazycollect.lazycollect.net.Person
import com.lazycollect.lazycollect.ui.groupByPerson
import com.lazycollect.lazycollect.ui.numberAnswer
import com.lazycollect.lazycollect.ui.validDay
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HelpersTest {
    private val token = "ca_" + "Ab-_9".repeat(8) + "xyz"

    @Test
    fun aLinkIsFoundInAnAddressOrAsABareToken() {
        assertEquals(token, linkToken("https://collect.alazy.app/c/$token"))
        assertEquals(token, linkToken("  https://collect.alazy.app/c/$token?x=1 "))
        assertEquals(token, linkToken(token))
        assertNull(linkToken("https://collect.alazy.app/c/short"))
        assertNull(linkToken("hello"))
    }

    @Test
    fun picturesAreScaledDownNeverUp() {
        assertEquals(1200 to 800, fitLongEdge(1200, 800))
        assertEquals(2400 to 1800, fitLongEdge(4800, 3600))
        assertEquals(1800 to 2400, fitLongEdge(3000, 4000))
        assertEquals(842 to 595, pageSize(4000, 2828))
    }

    @Test
    fun picturesAreMergedOnlyWhenThereAreSeveralAndTheyFit() {
        assertFalse(shouldCombine(listOf(100L)))
        assertTrue(shouldCombine(listOf(100L, 200L)))
        assertFalse(shouldCombine(listOf(MAX_UPLOAD / 2, MAX_UPLOAD / 2)))
    }

    @Test
    fun theExtensionFollowsTheFormat() {
        assertEquals("Passport.jpg", withExtension("Passport", "jpg"))
        assertEquals("IMG_1.pdf", withExtension("IMG_1.heic", "pdf"))
    }

    @Test
    fun numbersFollowTheWebRules() {
        assertEquals("1250.50", numberAnswer("1250,50"))
        assertEquals("12.5", numberAnswer(" 12.5 "))
        assertEquals("-3", numberAnswer("-3"))
        assertNull(numberAnswer("1,000"))
        assertNull(numberAnswer("1 000"))
        assertNull(numberAnswer("12.1234567"))
        assertNull(numberAnswer("abc"))
    }

    @Test
    fun datesAreRealDaysFrom1900To2100() {
        assertTrue(validDay("2027-03-31"))
        assertFalse(validDay("2027-02-30"))
        assertFalse(validDay("1899-12-31"))
        assertFalse(validDay("2101-01-01"))
        assertFalse(validDay("27-03-31"))
    }

    private fun item(id: String, pos: Int?) = ClientItem(id = id, label = id, status = "empty", personPos = pos)

    @Test
    fun itemsGroupByPersonWithGeneralFirst() {
        val people = listOf(Person(0, "principal", "Ana"), Person(1, "child", "Bo"), Person(2, "other", "Cy"))
        val groups = groupByPerson(listOf(item("b", 1), item("g", null), item("a", 0), item("a2", 0)), people)
        assertEquals(listOf(null, "Ana", "Bo"), groups.map { it.person?.name })
        assertEquals(listOf("a", "a2"), groups[1].items.map { it.id })
    }
}
