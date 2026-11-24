#if os(iOS)
import CollectKit
import Foundation
import Security

/// The sessions the app holds, in the Keychain of this device only.
struct Keychain {
    let service = "com.lazycollect.lazycollect.sessions"

    func read(_ account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        return SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    func write(_ account: String, _ data: Data?) {
        let match: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        guard let data else {
            SecItemDelete(match as CFDictionary)
            return
        }
        let update = SecItemUpdate(match as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecItemNotFound {
            var add = match
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }
}

final class DefaultsStore: ValueStore, @unchecked Sendable {
    func value(for key: String) -> String? { UserDefaults.standard.string(forKey: key) }
    func set(_ value: String?, for key: String) { UserDefaults.standard.set(value, forKey: key) }
}
#endif
