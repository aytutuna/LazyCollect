import Foundation
@testable import CollectKit

/// Answers the client's calls from a table, and keeps what it was asked.
final class Stub: URLProtocol {
    struct Reply {
        var status = 200
        var body = "{}"
    }

    nonisolated(unsafe) static var routes: [String: [Reply]] = [:]
    nonisolated(unsafe) static var seen: [URLRequest] = []
    nonisolated(unsafe) static var bodies: [Data] = []

    static func reset() {
        routes = [:]
        seen = []
        bodies = []
    }

    static func on(_ key: String, _ replies: Reply...) {
        routes[key] = replies
    }

    static func client() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [Stub.self]
        return APIClient(base: URL(string: "https://collect.test")!, session: URLSession(configuration: config))
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                body.append(buffer, count: n)
            }
            stream.close()
        }
        Stub.seen.append(request)
        Stub.bodies.append(body)
        let key = "\(request.httpMethod ?? "GET") \(request.url!.path)"
        var list = Stub.routes[key] ?? [Reply(status: 404, body: "{\"error\":\"not_found\"}")]
        let reply = list.count > 1 ? list.removeFirst() : list[0]
        Stub.routes[key] = list
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class MemoryStore: ValueStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]

    func value(for key: String) -> String? { lock.withLock { values[key] } }
    func set(_ value: String?, for key: String) { lock.withLock { values[key] = value } }
}

final class FakeAttester: Attester, @unchecked Sendable {
    var isSupported = true
    var hashes: [String: [Data]] = [:]
    var keys = 0

    func generateKey() async throws -> String {
        keys += 1
        return "key\(keys)"
    }

    func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data {
        hashes["attest", default: []].append(clientDataHash)
        return Data("attestation".utf8)
    }

    func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data {
        hashes["assert", default: []].append(clientDataHash)
        return Data("assertion".utf8)
    }
}
