import Foundation
import Security

/// Keeps the kiosk link in the Keychain: it carries a bearer token, so not in UserDefaults.
/// `AfterFirstUnlockThisDeviceOnly`: readable after a reboot once the iPad is unlocked, and never
/// restored onto another device from a backup.
enum KioskLinkStore {
    private static let service = "online.greenmonkey.kiosk"
    private static let account = "kiosk-link"

    static func load() -> KioskLink? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let raw = String(data: data, encoding: .utf8),
              case .success(let link) = KioskLink.parse(raw)
        else { return nil }
        return link
    }

    static func save(_ link: KioskLink) throws {
        let match: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(match as CFDictionary)
        var add = match
        add[kSecValueData as String] = Data(link.url.absoluteString.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }
}
