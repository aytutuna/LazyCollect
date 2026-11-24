package com.lazycollect.lazycollect.net

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.HttpUrl

fun json(code: Int, body: String): MockResponse =
    MockResponse.Builder().code(code).addHeader("Content-Type", "application/json; charset=utf-8").body(body).build()

fun ok(body: String = """{"ok":true}""") = json(200, body)

/** A stand-in for the Worker: answers each "METHOD /api/path" with its queued responses, the last one for good. */
class FakeServer : AutoCloseable {
    private val server = MockWebServer()
    private val routes = ConcurrentHashMap<String, ArrayDeque<MockResponse>>()

    val requests = CopyOnWriteArrayList<RecordedRequest>()
    val url: HttpUrl get() = server.url("/")

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val queue = routes["${request.method} ${request.url.encodedPath}"] ?: return json(404, """{"error":"not_found"}""")
                synchronized(queue) { return if (queue.size > 1) queue.removeFirst() else queue.first() }
            }
        }
        server.start()
    }

    fun on(route: String, vararg responses: MockResponse) {
        routes[route] = ArrayDeque(responses.toList())
    }

    fun calls(route: String) = requests.filter { "${it.method} ${it.url.encodedPath}" == route }

    fun stop() = server.close()

    override fun close() = server.close()
}
