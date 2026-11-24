package com.lazycollect.lazycollect.client

private val TOKEN = Regex("^[a-z]+_[\\w-]{43}$")
private val URL_PATH = Regex("/c/([^/?#\\s]+)")

/** The token in a pasted address or a bare token, or null when it is neither. */
fun linkToken(text: String): String? {
    val trimmed = text.trim()
    val candidate = URL_PATH.find(trimmed)?.groupValues?.get(1) ?: trimmed
    return candidate.takeIf { TOKEN.matches(it) }
}
