#if os(iOS)
import CollectKit
import StoreKit
import SwiftUI

/// The plan sold through the App Store: one auto-renewing subscription, paid from the first day. The purchase carries the
/// firm's account token, and the Worker is told which transaction it was; the price comes from App Store Connect.
@MainActor
final class PlanStore: ObservableObject {
    static let shared = PlanStore()
    static let productId = "com.lazycollect.lazycollect.plan.monthly"

    @Published private(set) var product: Product?
    @Published var message: String?
    @Published var busy = false

    func load() async {
        product = try? await Product.products(for: [Self.productId]).first
    }

    /// Purchases that finish outside the buy button (Ask to Buy approvals, renewals, one the Worker could not be told about last
    /// time) arrive here. A transaction is finished only once the Worker has taken it, so one that failed comes again at the next launch.
    func watch(_ session: ProSession) async {
        for await result in StoreKit.Transaction.updates {
            guard let firmId = session.me?.firm.id else { continue }
            if await attach(result, firmId: firmId, api: session.api) { await session.loadMe() }
        }
    }

    /// True when the Worker took the transaction. One bought for another account is left alone, unfinished.
    private func attach(_ result: VerificationResult<StoreKit.Transaction>, firmId: String, api: APIClient) async -> Bool {
        guard case .verified(let transaction) = result else {
            message = "The App Store could not confirm the purchase."
            return false
        }
        guard transaction.productID == Self.productId, let token = APIClient.accountToken(firmId: firmId), transaction.appAccountToken?.uuidString.lowercased() == token else { return false }
        do {
            try await api.billApple(transaction: String(transaction.id))
            await transaction.finish()
            message = nil
            return true
        } catch let e as APIError {
            // the purchase went through at Apple; what failed is telling the Worker, which the next launch or Restore tries again
            message = e.code == "unavailable" ? "The plan cannot be activated yet. Try again later." : AppModel.words(e)
        } catch {
            message = "That did not work. Try again."
        }
        return false
    }

    /// True when the purchase went through and the Worker has the plan.
    func buy(firmId: String, api: APIClient) async -> Bool {
        guard let product else {
            message = "The plan is not available right now. Try again later."
            return false
        }
        guard let token = APIClient.accountToken(firmId: firmId).flatMap({ UUID(uuidString: $0) }) else {
            message = "This account could not be checked. Sign out and sign in again."
            return false
        }
        busy = true
        defer { busy = false }
        message = nil
        do {
            switch try await product.purchase(options: [.appAccountToken(token)]) {
            case .success(let verification):
                return await attach(verification, firmId: firmId, api: api)
            case .pending:
                message = "The purchase is waiting for approval."
            default:
                break
            }
        } catch {
            message = "The purchase did not go through."
        }
        return false
    }

    /// Hands the Worker the transaction behind a subscription this Apple ID already holds.
    func restore(firmId: String, api: APIClient) async -> Bool {
        busy = true
        defer { busy = false }
        message = nil
        try? await AppStore.sync()
        for await result in StoreKit.Transaction.currentEntitlements {
            if await attach(result, firmId: firmId, api: api) { return true }
            if message != nil { return false }
        }
        message = "No plan was found for this account on this Apple ID."
        return false
    }
}
#endif
