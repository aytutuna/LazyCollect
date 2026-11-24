import Foundation

// The calls of the client's page (the token "me" is the app's own client session) and of the professional's dashboard.

extension APIClient {
    // MARK: client

    public func clientView() async throws -> ClientView {
        try await get("/c/me")
    }

    public func answer(item: String, _ value: JSON) async throws -> [Item] {
        let reply: ItemsReply = try await put("/c/me/items/\(item)/answer", ["answer": value])
        return reply.items
    }

    public func dates(item: String, expires: String?, issued: String?) async throws -> [Item] {
        var body: [String: JSON] = [:]
        if let expires { body["expires_on"] = .string(expires) }
        if let issued { body["issued_on"] = .string(issued) }
        let reply: ItemsReply = try await put("/c/me/items/\(item)/dates", .object(body))
        return reply.items
    }

    public func markUnavailable(item: String, note: String?) async throws {
        let _: JSON = try await post("/c/me/items/\(item)/unavailable", ["note": note.map { JSON.string($0) } ?? .null])
    }

    public func clearUnavailable(item: String) async throws {
        try await delete("/c/me/items/\(item)/unavailable")
    }

    public func deleteUpload(file: String) async throws {
        try await delete("/c/me/files/\(file)")
    }

    public func sendNote(_ body: String) async throws {
        let _: JSON = try await post("/c/me/notes", ["body": .string(body)])
    }

    public func uploadFile(item: String, file: URL, name: String, uploadId: UUID, progress: (@Sendable (Double) -> Void)? = nil) async throws -> UploadedFile {
        try await upload(path: "/c/me/items/\(item)/files", file: file, name: name, uploadId: uploadId, progress: progress)
    }

    public func exampleImage(item: String) async throws -> Data {
        try await data("GET", "/c/me/items/\(item)/example")
    }

    public func endClientSession() async {
        _ = try? await data("POST", "/app/client/logout")
    }

    // MARK: professional

    public func me() async throws -> Me {
        try await get("/me")
    }

    public func signOut() async {
        _ = try? await data("POST", "/auth/logout")
    }

    public func requests(view: String = "all", query: String = "", offset: Int = 0) async throws -> RequestPage {
        var items = [URLQueryItem(name: "view", value: view), URLQueryItem(name: "sort", value: "activity")]
        if !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
        if offset > 0 { items.append(URLQueryItem(name: "offset", value: String(offset))) }
        return try await get("/requests", query: items)
    }

    public func request(id: String) async throws -> RequestDetail {
        try await get("/requests/\(id)")
    }

    public func approve(request: String, item: ReviewItem) async throws {
        let _: JSON = try await post("/requests/\(request)/items/\(item.id)/review", reviewBody(item, ["decision": "approve"]))
    }

    public func reject(request: String, item: ReviewItem, reasons: [String], note: String?) async throws {
        let _: JSON = try await post("/requests/\(request)/items/\(item.id)/review", reviewBody(item, [
            "decision": "reject",
            "reasons": .array(reasons.map { JSON.string($0) }),
            "note": note.map { JSON.string($0) } ?? .null,
        ]))
    }

    // The review names the files (or the answer) the reviewer was looking at, and the Worker refuses it if they changed since.
    private func reviewBody(_ item: ReviewItem, _ fields: [String: JSON]) -> JSON {
        var body = fields
        body["files"] = .array(item.files.map { JSON.string($0.id) })
        body["answered_at"] = item.answerAt.map { JSON.number(Double($0)) } ?? .null
        return .object(body)
    }

    public func remind(request: String) async throws {
        let _: JSON = try await post("/requests/\(request)/remind")
    }

    public func link(request: String) async throws -> String? {
        let reply: LinkReply = try await get("/requests/\(request)/link")
        return reply.url
    }

    public func clients(query: String = "", offset: Int = 0) async throws -> ClientPage {
        var items: [URLQueryItem] = []
        if !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
        if offset > 0 { items.append(URLQueryItem(name: "offset", value: String(offset))) }
        return try await get("/clients/search", query: items)
    }

    public func templates() async throws -> [Template] {
        try await get("/templates")
    }

    public func addClient(name: String, email: String?, phone: String?, contactOK: Bool) async throws -> Client {
        var body: [String: JSON] = ["name": .string(name), "contact_ok": .bool(contactOK)]
        if let email, !email.isEmpty { body["email"] = .string(email) }
        if let phone, !phone.isEmpty { body["phone"] = .string(phone) }
        return try await post("/clients", .object(body))
    }

    public func createRequest(client: String, template: String, title: String, deadline: Date) async throws -> RequestDetail {
        let body: JSON = [
            "client_id": .string(client),
            "template_id": .string(template),
            "title": .string(title),
            "deadline": .number((deadline.timeIntervalSince1970 * 1000).rounded()),
        ]
        return try await post("/requests", body)
    }

    public func fileURL(file: FileRef) async throws -> URL {
        try await download(path: "/files/\(file.id)", name: file.name)
    }

    /// Makes the client's link for the request, and emails it when asked.
    public func sendLink(request: String, email: Bool) async throws -> String? {
        let reply: LinkReply = try await post("/requests/\(request)/link", ["send_email": .bool(email)])
        return reply.url
    }
}
