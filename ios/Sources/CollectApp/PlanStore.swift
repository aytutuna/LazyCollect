#if os(iOS)
import CollectKit
import StoreKit
import SwiftUI

/// The plan sold through the App Store: one auto-renewing subscription. The purchase carries the firm's account token, and the
/// Worker is told which transaction it was; the price and the free introductory weeks come from App Store Connect.
@MainActor
final class PlanStore: ObservableObject {
    static let productId = "com.lazycollect.lazycollect.plan.monthly"

    @Published private(set) var product: Product?
    @Published var message: String?
    @Published var busy = false

    func load() async {
        product = try? await Product.products(for: [Self.productId]).first
    }

    var offer: String? {
        guard let product, let intro = product.subscription?.introductoryOffer, intro.paymentMode == .freeTrial else { return nil }
        let unit = intro.period.unit
        let n = intro.period.value
        switch unit {
        case .day: return "\(n) free days"
        case .week: return n == 1 ? "1 free week" : "\(n) free weeks"
        case .month: return n == 1 ? "1 free month" : "\(n) free months"
        default: return "A free trial"
        }
    }

    /// True when the purchase went through and the Worker has the plan.
    func buy(firmId: String, api: APIClient) async -> Bool {
        guard let product else {
            message = "The plan is not available right now. Try again later."
            return false
        }
        guard let token = APIClient.accountToken(firmId: firmId).flatMap({ UUID(uuidString: $0) }) else { return false }
        busy = true
        defer { busy = false }
        do {
            switch try await product.purchase(options: [.appAccountToken(token)]) {
            case .success(let verification):
                guard case .verified(let transaction) = verification else {
                    message = "The App Store could not confirm the purchase."
                    return false
                }
                try await api.billApple(transaction: String(transaction.id))
                await transaction.finish()
                message = nil
                return true
            case .pending:
                message = "The purchase is waiting for approval."
            default:
                break
            }
        } catch let e as APIError {
            // the purchase went through at Apple; what failed is telling the Worker, which restoring tries again
            message = e.code == "unavailable" ? "The plan cannot be activated yet. Try again later." : AppModel.words(e)
        } catch {
            message = "The purchase did not go through."
        }
        return false
    }

    /// Hands the Worker the transaction behind a subscription this Apple ID already holds.
    func restore(firmId: String, api: APIClient) async -> Bool {
        busy = true
        defer { busy = false }
        try? await AppStore.sync()
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result, transaction.productID == Self.productId, transaction.appAccountToken.map({ $0.uuidString.lowercased() }) == APIClient.accountToken(firmId: firmId) else { continue }
            do {
                try await api.billApple(transaction: String(transaction.id))
                message = nil
                return true
            } catch let e as APIError {
                message = AppModel.words(e)
                return false
            } catch {
                message = "That did not work. Try again."
                return false
            }
        }
        message = "No plan was found for this account on this Apple ID."
        return false
    }
}
#endif
