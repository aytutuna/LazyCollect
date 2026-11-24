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
