#if os(iOS)
import AuthenticationServices
import CollectKit
import SwiftUI
import UIKit

enum PasskeyError: Error {
    case cancelled
    case bad
}

func b64url(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

func unb64url(_ text: String) -> Data? {
    var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while s.count % 4 != 0 { s += "=" }
    return Data(base64Encoded: s)
}

/// Asks the phone for a passkey for the WebAuthn options the Worker sent, and turns the answer back into the JSON it checks.
@MainActor
final class PasskeyRunner: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var continuation: CheckedContinuation<ASAuthorization, Error>?

    func run(kind: String, options: JSON, name: String) async throws -> JSON {
        guard case .object(let o) = options, let challenge = o["challenge"]?.string.flatMap(unb64url) else { throw PasskeyError.bad }
        let request: ASAuthorizationRequest
        if kind == "authenticate" {
            guard let rpId = o["rpId"]?.string else { throw PasskeyError.bad }
            let r = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId).createCredentialAssertionRequest(challenge: challenge)
            if case .array(let list)? = o["allowCredentials"] {
                r.allowedCredentials = list.compactMap { entry in
                    guard case .object(let e) = entry, let id = e["id"]?.string.flatMap(unb64url) else { return nil }
                    return ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: id)
                }
            }
            request = r
        } else {
            guard case .object(let rp)? = o["rp"], let rpId = rp["id"]?.string,
                  case .object(let user)? = o["user"], let userId = user["id"]?.string.flatMap(unb64url) else { throw PasskeyError.bad }
            let label = user["name"]?.string ?? name
            request = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId).createCredentialRegistrationRequest(challenge: challenge, name: label, userID: userId)
        }
        let result = try await perform(request)
        switch result.credential {
        case let c as ASAuthorizationPlatformPublicKeyCredentialAssertion:
            let response: [String: JSON] = [
                "clientDataJSON": .string(b64url(c.rawClientDataJSON)),
                "authenticatorData": .string(b64url(c.rawAuthenticatorData)),
                "signature": .string(b64url(c.signature)),
                "userHandle": .string(b64url(c.userID)),
            ]
            return credential(c.credentialID, response)
        case let c as ASAuthorizationPlatformPublicKeyCredentialRegistration:
            let response: [String: JSON] = [
                "clientDataJSON": .string(b64url(c.rawClientDataJSON)),
                "attestationObject": .string(b64url(c.rawAttestationObject ?? Data())),
                "transports": .array([.string("internal"), .string("hybrid")]),
            ]
            return credential(c.credentialID, response)
        default:
            throw PasskeyError.bad
        }
    }

    private func credential(_ id: Data, _ response: [String: JSON]) -> JSON {
        .object([
            "id": .string(b64url(id)),
            "rawId": .string(b64url(id)),
            "type": .string("public-key"),
            "response": .object(response),
            "clientExtensionResults": .object([:]),
            "authenticatorAttachment": .string("platform"),
        ])
    }

    private func perform(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        Task { @MainActor in
            continuation?.resume(returning: authorization)
            continuation = nil
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        Task { @MainActor in
            let cancelled = (error as? ASAuthorizationError)?.code == .canceled
            continuation?.resume(throwing: cancelled ? PasskeyError.cancelled : error)
            continuation = nil
        }
    }

    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
        }
    }
}
#endif
