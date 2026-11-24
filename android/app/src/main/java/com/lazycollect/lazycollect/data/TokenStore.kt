package com.lazycollect.lazycollect.data

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/** The session token in a file, sealed by [seal]; the file lives where Android does not back it up. */
class TokenStore(private val file: File, private val seal: (String) -> String, private val open: (String) -> String?) {
    fun load(): String? = runCatching { open(file.readText()) }.getOrNull()

    fun save(token: String) {
        val tmp = File(file.parentFile, "${file.name}.tmp")
        tmp.writeText(seal(token))
        Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }

    fun clear() {
        file.delete()
    }
}
