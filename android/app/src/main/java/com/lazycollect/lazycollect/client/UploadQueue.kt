package com.lazycollect.lazycollect.client

import com.lazycollect.lazycollect.net.Api
import com.lazycollect.lazycollect.net.ApiError
import com.lazycollect.lazycollect.net.ApiJson
import java.io.File
import java.io.InputStream
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

const val MAX_UPLOAD = 25L * 1024 * 1024
private const val KEEP_DAYS = 14L
private const val AUTO_TRIES = 6
private const val FIRST_BACKOFF = 10_000L

/** How long a file waits after its [tries]th failed try: 10 s, doubling to 320 s. */
fun backoff(tries: Int): Long = FIRST_BACKOFF shl (tries - 1).coerceIn(0, 5)

/** Thrown by [UploadQueue.add] when the checklist it was prepared for has been left or replaced. */
class SessionEnded : Exception()

@Serializable
data class Job(
    val id: String,
    val itemId: String,
    val name: String,
    val size: Long,
    val uploadId: String,
    val at: Long,
    val tries: Int = 0,
    // set once the job has given up: a server code, and the person has to press retry
    val failed: String? = null,
    // the earliest time the next automatic try may start; a job that keeps failing waits here without holding the others back
    val next: Long = 0,
)

/** What a pass over the queue left behind. */
enum class Pass { Done, Later, SignedOut }

/**
 * Files waiting to go to the server. Each one lives in the app's own storage with a small description beside it, so a
 * file survives the process. They go one at a time; a file keeps its Upload-Id for every try, which makes a repeat harmless.
 */
class UploadQueue(private val dir: File, private val api: Api, private val now: () -> Long = System::currentTimeMillis) {
    private val flow = MutableStateFlow<List<Job>>(emptyList())
    private val lock = Mutex()

    // every change to the list and to the files beside it happens under this, so forget() cannot interleave with a write
    private val mon = Any()
    private val dirty = AtomicBoolean(false)
    private var generation = 0

    /** Changes each time everything is forgotten; work prepared for an earlier value is refused by [add]. */
    val epoch: Int get() = synchronized(mon) { generation }

    val jobs: StateFlow<List<Job>> get() = flow

    private val sending = MutableStateFlow<Map<String, Float>>(emptyMap())

    /** How much of the file being sent has gone, 0 to 1, by job id; only the one in flight is listed. */
    val progress: StateFlow<Map<String, Float>> get() = sending

    init {
        dir.mkdirs()
        val cutoff = now() - KEEP_DAYS * 24 * 3600 * 1000
        val found = dir.listFiles { f -> f.extension == "json" }.orEmpty().mapNotNull { f ->
            runCatching { ApiJson.decodeFromString<Job>(f.readText()) }.getOrNull().also { if (it == null) f.delete() }
        }
        found.filter { it.at < cutoff }.forEach { drop(it.id) }
        val known = found.map { it.id }.toSet()
        dir.listFiles { f -> f.extension == "bin" }.orEmpty().filter { it.nameWithoutExtension !in known }.forEach { it.delete() }
        flow.value = found.filter { it.at >= cutoff }.sortedBy { it.at }
    }

    private fun data(id: String) = File(dir, "$id.bin")

    private fun meta(id: String) = File(dir, "$id.json")

    private fun save(job: Job) {
        meta(job.id).writeText(ApiJson.encodeToString(job))
    }

    private fun drop(id: String) {
        data(id).delete()
        meta(id).delete()
    }

    /**
     * Copies [input] into the queue for the checklist that was open at [epoch]. Throws [ApiError.Other] with too_big when it is
     * over what the server takes, and [SessionEnded] when that checklist has gone meanwhile.
     */
    fun add(itemId: String, name: String, input: InputStream, epoch: Int = this.epoch): Job {
        val id = UUID.randomUUID().toString()
        try {
            var size = 0L
            data(id).outputStream().use { out ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    size += n
                    if (size > MAX_UPLOAD) throw ApiError.Other(413, "too_big")
                    out.write(buffer, 0, n)
                }
            }
            val job = Job(id, itemId, name, size, UUID.randomUUID().toString(), now())
            synchronized(mon) {
                if (epoch != generation) throw SessionEnded()
                save(job)
                flow.value = flow.value + job
            }
            dirty.set(true)
            return job
        } catch (e: Throwable) {
            drop(id)
            throw e
        }
    }

    fun retry(id: String) {
        change(id) { it.copy(failed = null, tries = 0, next = 0) }
        dirty.set(true)
    }

    /** Makes a running pass go round once more. */
    fun touch() = dirty.set(true)

    /** The phone is back online: what waited for a backoff may go now. */
    fun wake() {
        synchronized(mon) { flow.value.filter { it.failed == null && it.next > 0 }.forEach { change(it.id) { j -> j.copy(next = 0) } } }
        dirty.set(true)
    }

    fun remove(id: String) {
        synchronized(mon) {
            drop(id)
            flow.value = flow.value.filter { it.id != id }
        }
    }

    /** Drops what belongs to items the professional has taken off the list. Returns how many went. */
    fun reconcile(itemIds: Set<String>): Int {
        val gone = flow.value.filter { it.itemId !in itemIds }
        gone.forEach { remove(it.id) }
        return gone.size
    }

    /** Everything goes: the link is gone, or the person left. */
    fun forget() {
        synchronized(mon) {
            generation++
            val all = flow.value
            flow.value = emptyList()
            all.forEach { drop(it.id) }
        }
    }

    private fun change(id: String, update: (Job) -> Job) {
        synchronized(mon) {
            val job = flow.value.firstOrNull { it.id == id } ?: return
            val changed = update(job)
            save(changed)
            flow.value = flow.value.map { if (it.id == id) changed else it }
        }
    }

    /** When the soonest waiting file may be tried again, or null when nothing is waiting. */
    fun nextAttempt(): Long? = flow.value.filter { it.failed == null }.minOfOrNull { it.next }

    /**
     * Sends what is due, once each per round, including files added while it runs. A file added or retried during the last
     * round starts another one. [Pass.Later] means files are left that wait for their next try, see [nextAttempt].
     */
    suspend fun run(): Pass = lock.withLock {
        do {
            dirty.set(false)
            val attempted = HashSet<String>()
            while (true) {
                val at = now()
                val job = flow.value.firstOrNull { it.failed == null && it.next <= at && it.id !in attempted } ?: break
                attempted += job.id
                if (!data(job.id).exists()) {
                    change(job.id) { it.copy(failed = "missing_file") }
                    continue
                }
                try {
                    sending.value = mapOf(job.id to 0f)
                    api.upload(job.itemId, job.name, job.uploadId, data(job.id)) { sent ->
                        if (job.size > 0) sending.value = mapOf(job.id to (sent.toFloat() / job.size).coerceIn(0f, 1f))
                    }
                    remove(job.id)
                } catch (e: ApiError.Unauthorized) {
                    return@withLock Pass.SignedOut
                } catch (e: ApiError) {
                    if (transient(e)) {
                        val tries = job.tries + 1
                        if (tries > AUTO_TRIES) change(job.id) { it.copy(tries = tries, failed = e.code) }
                        else change(job.id) { it.copy(tries = tries, next = now() + backoff(tries)) }
                    } else {
                        change(job.id) { it.copy(failed = e.code) }
                    }
                } finally {
                    sending.value = emptyMap()
                }
            }
        } while (dirty.get())
        if (flow.value.any { it.failed == null }) Pass.Later else Pass.Done
    }

    private fun transient(e: ApiError) = when (e) {
        is ApiError.Network, is ApiError.RateLimited -> true
        is ApiError.Conflict -> e.code == "busy"
        is ApiError.Other -> e.status == 408 || e.status >= 500
        else -> false
    }
}
