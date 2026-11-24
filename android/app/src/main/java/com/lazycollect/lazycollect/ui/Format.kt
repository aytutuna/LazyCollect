package com.lazycollect.lazycollect.ui

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

// Dates mean the account's time zone, not the phone's: a deadline is 23:59 there.
private fun zone(tz: String): ZoneId = runCatching { ZoneId.of(tz) }.getOrDefault(ZoneId.systemDefault())

private val CANADA = Locale.forLanguageTag("en-CA")

fun formatDate(ms: Long, tz: String): String =
    DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(CANADA).withZone(zone(tz)).format(Instant.ofEpochMilli(ms))

fun formatDateTime(ms: Long, tz: String): String =
    DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withLocale(CANADA).withZone(zone(tz)).format(Instant.ofEpochMilli(ms))

/** A calendar day as the server writes it (2027-03-31), in the same style as the other dates. */
fun formatDay(day: String): String = runCatching {
    DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(CANADA).format(java.time.LocalDate.parse(day))
}.getOrDefault(day)

/** Whole days from today to [ms], both read in the account's zone; negative once it has passed. */
fun dayDiff(ms: Long, now: Long, tz: String): Int {
    val zone = zone(tz)
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val then = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
    return java.time.temporal.ChronoUnit.DAYS.between(today, then).toInt()
}

/** "1.2 MB" the way the web shows a size. */
fun formatSize(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "${Math.round(bytes / 1024.0)} kB"
    else -> String.format(CANADA, "%.1f MB", bytes / 1024.0 / 1024.0)
}
