import Foundation

/// What the Worker said no with: the HTTP status and the `error` code of its JSON body ("network" when nothing came back).
public struct APIError: Error, Equatable {
    public let status: Int
    public let code: String

    public init(status: Int, code: String) {
        self.status = status
        self.code = code
    }

    public static let network = APIError(status: 0, code: "network")
}

public struct Done: Decodable {}

public final class APIClient: @unchecked Sendable {
    public let base: URL
    private let session: URLSession
    private let lock = NSLock()
    private var bearer: String?

    public init(base: URL = URL(string: "https://collect.alazy.app")!, session: URLSession = .shared) {
        self.base = base
        self.session = session
    }

    /// The session token the calls carry, the staff member's or a client's.
    public var token: String? {
        get { lock.withLock { bearer } }
        set { lock.withLock { bearer = newValue } }
    }

    public static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    private static let headerSafe = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")

    public enum Auth {
        case token
        case none
        /// The second sign-in step, `Authorization: Pending <token>`.
        case pending(String)
        /// A token other than the one the client holds, for one call.
        case bearer(String)
    }

    func request(_ method: String, _ path: String, query: [URLQueryItem] = [], auth: Auth = .token, headers: [String: String] = [:]) -> URLRequest {
        var comps = URLComponents(url: base.appendingPathComponent("api" + path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        if method != "GET" { req.setValue("1", forHTTPHeaderField: "X-Collect") }
        switch auth {
        case .token: if let t = token { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        case .none: break
        case .pending(let t): req.setValue("Pending \(t)", forHTTPHeaderField: "Authorization")
        case .bearer(let t): req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        }
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        return req
    }

    private func check(_ data: Data, _ response: URLResponse) throws -> Data {
        guard let http = response as? HTTPURLResponse else { throw APIError.network }
        guard (200..<300).contains(http.statusCode) else {
            let code = (try? JSONDecoder().decode([String: JSON].self, from: data))?["error"]?.string
            throw APIError(status: http.statusCode, code: code ?? "server_error")
        }
        return data
    }

    public func data(_ method: String, _ path: String, query: [URLQueryItem] = [], body: JSON? = nil, auth: Auth = .token, headers: [String: String] = [:]) async throws -> Data {
        var req = request(method, path, query: query, auth: auth, headers: headers)
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(body)
        }
        do {
            let (data, response) = try await session.data(for: req)
            return try check(data, response)
        } catch let e as APIError {
            throw e
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw APIError.network
        }
    }

    public func call<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = [], body: JSON? = nil, auth: Auth = .token) async throws -> T {
        let data = try await self.data(method, path, query: query, body: body, auth: auth)
        do {
            return try Self.decoder.decode(T.self, from: data)
        } catch {
            throw APIError(status: 200, code: "bad_reply")
        }
    }

    public func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        try await call("GET", path, query: query)
    }

    public func post<T: Decodable>(_ path: String, _ body: JSON? = nil, auth: Auth = .token) async throws -> T {
        try await call("POST", path, body: body, auth: auth)
    }

    public func put<T: Decodable>(_ path: String, _ body: JSON) async throws -> T {
        try await call("PUT", path, body: body)
    }

    public func patch<T: Decodable>(_ path: String, _ body: JSON) async throws -> T {
        try await call("PATCH", path, body: body)
    }

    public func delete(_ path: String) async throws {
        _ = try await data("DELETE", path)
    }

    /// A file for the client's request. The Worker wants a stable Upload-Id, so a retry after a cut
    /// connection is answered with the stored file instead of making a second one.
    public func upload(path: String, file: URL, name: String, uploadId: UUID, progress: (@Sendable (Double) -> Void)? = nil) async throws -> UploadedFile {
        var req = request("PUT", path, headers: [
            "X-File-Name": name.addingPercentEncoding(withAllowedCharacters: Self.headerSafe) ?? "file",
            "Upload-Id": uploadId.uuidString.lowercased(),
            "Content-Type": "application/octet-stream",
        ])
        req.timeoutInterval = 120
        let watcher = progress.map { UploadProgress($0) }
        do {
            let (data, response) = try await session.upload(for: req, fromFile: file, delegate: watcher)
            return try Self.decoder.decode(UploadedFile.self, from: try check(data, response))
        } catch let e as APIError {
            throw e
        } catch is CancellationError {
            throw CancellationError()
        } catch is DecodingError {
            throw APIError(status: 200, code: "bad_reply")
        } catch {
            throw APIError.network
        }
    }

    /// A file of the professional's side, saved under the temporary folder with the name the Worker gives it.
    public func download(path: String, name: String) async throws -> URL {
        let req = request("GET", path)
        let (tmp, response) = try await session.download(for: req)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError(status: (response as? HTTPURLResponse)?.statusCode ?? 0, code: "download")
        }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let target = dir.appendingPathComponent(name.isEmpty ? "file" : name)
        try FileManager.default.moveItem(at: tmp, to: target)
        return target
    }
}

private final class UploadProgress: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let report: @Sendable (Double) -> Void

    init(_ report: @escaping @Sendable (Double) -> Void) { self.report = report }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        if totalBytesExpectedToSend > 0 { report(Double(totalBytesSent) / Double(totalBytesExpectedToSend)) }
    }
}
