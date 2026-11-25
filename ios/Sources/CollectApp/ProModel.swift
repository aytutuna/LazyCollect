#if os(iOS)
import CollectKit
import SwiftUI

/// The signed-in professional: their calls, who they are and what the plan allows.
@MainActor
final class ProSession: ObservableObject {
    @Published private(set) var me: Me?
    @Published var blocked = false
    @Published var problem: String?

    let api: APIClient
    private let token: String
    private let app: AppModel

    init(token: String, app: AppModel) {
        self.token = token
        self.app = app
        api = app.api(token: token)
    }

    func loadMe() async {
        do {
            me = try await api.me()
        } catch {
            handle(error)
        }
    }

    /// Runs a call and turns a refusal into words. A session the Worker no longer knows signs the app out; a plan that has ended
    /// blocks the writes.
    func handle(_ error: Error) {
        guard let e = error as? APIError else {
            problem = "That did not work. Try again."
            return
        }
        if e.status == 401 {
            app.sessionEnded(token)
            app.notice = "You were signed out. Sign in again."
        } else if e.status == 402 {
            blocked = true
            problem = AppModel.words(e)
        } else {
            problem = AppModel.words(e)
        }
    }

    func signOut() async {
        PlanStore.shared.message = nil
        await app.signOutStaff()
    }
}
#endif
