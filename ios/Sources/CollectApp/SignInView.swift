#if os(iOS)
import CollectKit
import SwiftUI

/// A professional's sign-in: the code that comes by email, then the passkey step if the account asks for one.
struct SignInView: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.dismiss) private var dismiss

    private enum Stage: Equatable {
        case email
        case code
        case passkey(pending: String, kind: String)
    }

    @State private var stage = Stage.email
    @State private var email = ""
    @State private var code = ""
    @State private var busy = false
    @State private var problem: String?
    private let runner = PasskeyRunner()

    var body: some View {
        Form {
            switch stage {
            case .email:
                Section {
                    TextField("Email", text: $email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text("We email you a code. If it does not arrive, look in the junk folder.")
                }
                Section {
                    Button("Send the code", action: sendCode).disabled(email.isEmpty || busy)
                }
            case .code:
                Section {
                    TextField("Code from the email", text: $code)
                        .textContentType(.oneTimeCode)
                        .keyboardType(.numberPad)
                } footer: {
                    Text("Sent to \(Backend.normalized(email)).")
                }
                Section {
                    Button("Sign in", action: verify).disabled(code.count < 4 || busy)
                    Button("Use another email") { stage = .email; code = "" }
                }
            case .passkey(let pending, let kind):
                Section {
                    Text(kind == "register" ? "This account needs a passkey. Add one to this iPhone to go on." : "Use your passkey to finish signing in.")
                    Button(kind == "register" ? "Add a passkey" : "Use passkey") { passkey(pending: pending, kind: kind) }.disabled(busy)
                }
            }
            if let problem {
                Section { Text(problem).foregroundStyle(.red).accessibilityIdentifier("problem") }
            }
        }
        .navigationTitle("Sign in")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if busy { ProgressView() } }
    }

    private func run(_ work: @escaping () async throws -> Void) {
        busy = true
        problem = nil
        Task {
            defer { busy = false }
            do {
                try await work()
            } catch let e as APIError {
                problem = AppModel.words(e)
            } catch let e as AppCheckError where e == .unsupported {
                problem = "This iPhone cannot prove it is a real device, so it cannot sign in."
            } catch PasskeyError.cancelled {
                problem = "The passkey step was cancelled."
            } catch {
                problem = "That did not work. Try again."
            }
        }
    }

    private func sendCode() {
        run {
            try await app.backend.sendCode(to: email)
            stage = .code
        }
    }

    private func verify() {
        run {
            let reply = try await app.backend.verify(email: email, code: code)
            if let token = reply.token {
                app.signedIn(token: token)
            } else if let pending = reply.pending, let step = reply.step {
                stage = .passkey(pending: pending, kind: step == "enrol" ? "register" : "authenticate")
            } else {
                throw APIError(status: 200, code: "bad_reply")
            }
        }
    }

    private func passkey(pending: String, kind: String) {
        run {
            let asked = try await app.backend.passkeyOptions(pending: pending)
            let response = try await runner.run(kind: asked.kind, options: asked.options, name: Backend.normalized(email))
            let token = try await app.backend.passkeyVerify(pending: pending, response: response, name: asked.kind == "register" ? "Lazy Collect for iPhone" : nil)
            app.signedIn(token: token)
        }
    }
}
#endif
