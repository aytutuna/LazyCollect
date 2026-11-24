#if os(iOS)
import CollectKit
import SwiftUI

struct ClientSession: Codable, Identifiable, Equatable {
    var token: String
    var firm: String
    var title: String
    var id: String { token }
}

struct Saved: Codable {
    var staff: String?
    var clients: [ClientSession] = []
}

enum Route: Hashable {
    case client(String)
    case signIn
}

/// What the app holds: a professional's session and the client sessions made from links, kept in the Keychain.
@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var saved: Saved
    @Published var path: [Route] = []
    @Published var notice: String?
    @Published var busy = false

    let base: URL
    let backend: Backend
    private let keychain = Keychain()

    init(base: URL = URL(string: "https://collect.alazy.app")!) {
        self.base = base
        let api = APIClient(base: base)
        backend = Backend(api: api, check: AppCheck(api: api, attester: AppAttestService(), store: DefaultsStore()))
        saved = keychain.read("saved").flatMap { try? JSONDecoder().decode(Saved.self, from: $0) } ?? Saved()
    }

    private func persist() {
        keychain.write("saved", try? JSONEncoder().encode(saved))
    }

    /// A client of the professional or the professional's own calls, each with its own token.
    func api(token: String) -> APIClient {
        let api = APIClient(base: base)
        api.token = token
        return api
    }

    var staffAPI: APIClient? {
        saved.staff.map { api(token: $0) }
    }

    func signedIn(token: String) {
        saved.staff = token
        persist()
        path = []
    }

    func signOutStaff() async {
        await staffAPI?.signOut()
        saved.staff = nil
        persist()
        path = []
    }

    func sessionEnded(_ token: String) {
        if saved.staff == token {
            saved.staff = nil
        } else {
            saved.clients.removeAll { $0.token == token }
        }
        persist()
        path = []
    }

    func remove(client token: String) async {
        await api(token: token).endClientSession()
        saved.clients.removeAll { $0.token == token }
        persist()
    }

    func updateClient(_ token: String, firm: String, title: String) {
        guard let i = saved.clients.firstIndex(where: { $0.token == token }), saved.clients[i].firm != firm || saved.clients[i].title != title else { return }
        saved.clients[i].firm = firm
        saved.clients[i].title = title
        persist()
    }

    /// A link from an email or a message: the universal link, or whatever was pasted.
    func open(link text: String) async {
        guard let link = ClientLink.token(in: text) else {
            notice = "That is not a Lazy Collect link."
            return
        }
        busy = true
        defer { busy = false }
        do {
            let exchange = try await backend.exchange(link: link)
            let view = try await api(token: exchange.token).clientView()
            saved.clients.removeAll { $0.title == view.title && $0.firm == view.firmName }
            saved.clients.insert(ClientSession(token: exchange.token, firm: view.firmName, title: view.title), at: 0)
            persist()
            path = [.client(exchange.token)]
        } catch let e as APIError {
            notice = Self.words(e)
        } catch let e as AppCheckError where e == .unsupported {
            notice = "This iPhone cannot prove it is a real device, so the link cannot be opened here. Open it in Safari instead."
        } catch {
            notice = "The link could not be opened."
        }
    }

    nonisolated static func words(_ e: APIError) -> String {
        switch e.code {
        case "network": return "No connection. Check the network and try again."
        case "not_found": return "This link has expired or was replaced. Ask for a new one."
        case "rate_limited": return "Too many tries. Wait a minute and try again."
        case "unavailable": return "The app is not ready yet. Please try again later."
        case "attestation": return "This iPhone could not be checked. Try again."
        case "invalid": return "That does not look right."
        case "too_many": return "Too many wrong codes. Try again tomorrow."
        case "disabled": return "This account is turned off."
        case "plan": return "The plan has ended. Subscribe in Settings to go on."
        case "legal_hold": return "This request is on hold and cannot be changed."
        case "approved": return "This one was already approved."
        case "limit": return "That is the most files this item takes."
        case "too_big": return "The file is over 25 MB."
        case "unsupported_type": return "That kind of file is not accepted. Send a photo, a PDF, or a document scan."
        case "firm_profile": return "Add your business name in Settings first."
        case "address_needed": return "Add your mailing address on the website first."
        case "client_email_needed": return "This client has no email address that allows messages."
        case "client_unsubscribed": return "This client asked to stop emails."
        case "too_soon": return "A reminder went out in the last day."
        case "nothing_missing": return "Nothing is missing."
        case "not_open": return "This request is not open."
        default: return "Something went wrong (\(e.code))."
        }
    }
}
#endif
