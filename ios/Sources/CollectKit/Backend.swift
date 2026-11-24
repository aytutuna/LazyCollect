import Foundation

/// The sign-in side of the Worker's app endpoints (`/api/app/...`) and the second step after the email code.
public final class Backend: @unchecked Sendable {
    public let api: APIClient
    public let check: AppCheck

    public init(api: APIClient, check: AppCheck) {
        self.api = api
        self.check = check
    }

    /// The Worker reads an address in this form, and the phone signs it, so both must agree.
    public static func normalized(_ email: String) -> String {
        email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    public func sendCode(to email: String) async throws {
        let address = Self.normalized(email)
        let _: Done = try await check.attested(for: address) { attestation in
            try await api.post("/app/auth/start", ["email": .string(address), "platform": "ios", "attestation": attestation ?? .null], auth: .none)
        }
    }

    public func verify(email: String, code: String) async throws -> SignIn {
        try await api.post("/app/auth/verify", ["email": .string(Self.normalized(email)), "code": .string(code.trimmingCharacters(in: .whitespaces)), "platform": "ios"], auth: .none)
    }

    /// The WebAuthn options for the passkey step, and which ceremony it is ("authenticate" or "register").
    public func passkeyOptions(pending: String) async throws -> (kind: String, options: JSON) {
        let reply: JSON = try await api.post("/auth/pending/options", auth: .pending(pending))
        guard case .object(let o) = reply, let kind = o["kind"]?.string, let options = o["options"] else { throw APIError(status: 200, code: "bad_reply") }
        return (kind, options)
    }

    /// Hands the passkey's answer in; the session token comes back.
    public func passkeyVerify(pending: String, response: JSON, name: String? = nil) async throws -> String {
        var body: [String: JSON] = ["response": response]
        if let name { body["name"] = .string(name) }
        let reply: SignIn = try await api.post("/auth/pending/verify", .object(body), auth: .pending(pending))
        guard let token = reply.token else { throw APIError(status: 200, code: "bad_reply") }
        return token
    }

    /// A client's link, as the email carries it, for a session of the app's own.
    public func exchange(link token: String) async throws -> Exchange {
        try await check.attested(for: token) { attestation in
            try await api.post("/app/client/exchange", ["token": .string(token), "platform": "ios", "attestation": attestation ?? .null], auth: .none)
        }
    }

    public func registerPush(_ token: String) async throws {
        let _: Done = try await api.call("PUT", "/app/push", body: ["token": .string(token)])
    }
}

public enum ClientLink {
    /// The link token in a pasted address or a bare token: `<region>_<43 characters>`.
    public static func token(in text: String) -> String? {
        guard let range = text.range(of: "[a-z]+_[A-Za-z0-9_-]{43}", options: .regularExpression) else { return nil }
        return String(text[range])
    }
}
