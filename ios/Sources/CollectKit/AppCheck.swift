import CryptoKit
import Foundation

/// The phone's App Attest, behind a protocol so the flow can be tested without a device.
public protocol Attester: Sendable {
    var isSupported: Bool { get }
    func generateKey() async throws -> String
    func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data
    func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data
}

/// Small values the app keeps between launches.
public protocol ValueStore: Sendable {
    func value(for key: String) -> String?
    func set(_ value: String?, for key: String)
}

public enum AppCheckError: Error, Equatable {
    /// The Worker wants a proof and this phone cannot make one.
    case unsupported
}

/// What the Worker wants in place of Turnstile. It hands out a challenge; once per install the phone attests its key, and every
/// sign-in or link exchange carries an assertion over the challenge and the data of the call.
public final class AppCheck: @unchecked Sendable {
    static let keyName = "appattest.key"

    private let api: APIClient
    private let attester: Attester
    private let store: ValueStore

    public init(api: APIClient, attester: Attester, store: ValueStore) {
        self.api = api
        self.attester = attester
        self.store = store
    }

    /// What the device signs: the challenge and the data of the request it goes with.
    public static func bindingHash(challenge: String, data: String) -> Data {
        Data(SHA256.hash(data: Data("\(challenge).\(data)".utf8)))
    }

    private func newChallenge() async throws -> Challenge {
        try await api.post("/app/challenge", ["platform": "ios"], auth: .none)
    }

    /// The attestation object for a call about `data`, or nil when the Worker does not check this platform (a local one).
    public func attestation(for data: String) async throws -> JSON? {
        var challenge = try await newChallenge()
        guard challenge.required else { return nil }
        guard attester.isSupported else { throw AppCheckError.unsupported }
        var keyId = store.value(for: Self.keyName)
        if keyId == nil {
            let key = try await attester.generateKey()
            let hash = Self.bindingHash(challenge: challenge.challenge, data: "attest")
            let object = try await attester.attestKey(key, clientDataHash: hash)
            let _: Done = try await api.post("/app/attest", ["key_id": .string(key), "challenge": .string(challenge.challenge), "attestation": .string(object.base64EncodedString())], auth: .none)
            store.set(key, for: Self.keyName)
            keyId = key
            // the attest call used the first challenge up
            challenge = try await newChallenge()
        }
        let assertion = try await attester.generateAssertion(keyId!, clientDataHash: Self.bindingHash(challenge: challenge.challenge, data: data))
        return ["challenge": .string(challenge.challenge), "key_id": .string(keyId!), "assertion": .string(assertion.base64EncodedString())]
    }

    /// Runs a call with its attestation. A key the Worker does not know any more (a rebuilt database, a restored phone) is
    /// dropped and made again once.
    public func attested<T>(for data: String, _ call: (JSON?) async throws -> T) async throws -> T {
        do {
            return try await call(try await attestation(for: data))
        } catch let e as APIError where e.code == "attestation" && store.value(for: Self.keyName) != nil {
            store.set(nil, for: Self.keyName)
            return try await call(try await attestation(for: data))
        }
    }
}
