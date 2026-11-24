package com.lazycollect.lazycollect.client

import java.io.File

/** Removes what earlier camera shots left in [dir], except the file named [keep], which a camera may still be writing. */
fun clearCameraFiles(dir: File, keep: String?) {
    dir.listFiles().orEmpty().filter { it.name != keep }.forEach { it.delete() }
}
