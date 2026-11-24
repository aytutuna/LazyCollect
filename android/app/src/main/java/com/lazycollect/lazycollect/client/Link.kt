package com.lazycollect.lazycollect.client

import android.content.Intent
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

private val TOKEN = Regex("^[a-z]+_[\\w-]{43}$")
private val URL_PATH = Regex("/c/([^/?#\\s]+)")

/** The token in a pasted address or a bare token, or null when it is neither. */
fun linkToken(text: String): String? {
    val trimmed = text.trim()
    val candidate = URL_PATH.find(trimmed)?.groupValues?.get(1) ?: trimmed
    return candidate.takeIf { TOKEN.matches(it) }
}

/** The token of an address of exactly the form [base]/c/<token>, for any of the [bases] the app talks to; null for anything else. */
fun appLinkToken(url: String, bases: List<String>): String? {
    val parsed = url.toHttpUrlOrNull() ?: return null
    val known = bases.mapNotNull { it.toHttpUrlOrNull() }.any { it.scheme == parsed.scheme && it.host == parsed.host && it.port == parsed.port }
    val parts = parsed.pathSegments.filter { it.isNotEmpty() }
    if (!known || parts.size != 2 || parts[0] != "c") return null
    return linkToken(parts[1])
}

/** The token a VIEW intent carries. */
fun Intent.collectToken(bases: List<String>): String? {
    if (action != Intent.ACTION_VIEW) return null
    return data?.toString()?.let { appLinkToken(it, bases) }
}
