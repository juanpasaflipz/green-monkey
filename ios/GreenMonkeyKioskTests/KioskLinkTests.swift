import Foundation
import Testing
@testable import GreenMonkeyKiosk

struct KioskLinkTests {
    private func parse(_ raw: String) throws -> KioskLink {
        try KioskLink.parse(raw).get()
    }

    @Test func acceptsAKioskLinkAndNormalizesIt() throws {
        let link = try parse("  HTTPS://App.GreenMonkey.online/kiosk#AbC-123_xyzAbC-123_xyz \n")
        #expect(link.url.absoluteString == "https://app.greenmonkey.online/kiosk#AbC-123_xyzAbC-123_xyz")
        #expect(link.token == "AbC-123_xyzAbC-123_xyz")
        #expect(link.maskedDescription == "app.greenmonkey.online/kiosk · ••••_xyz")
    }

    @Test func dropsAQueryAndATrailingSlash() throws {
        let link = try parse("https://app.greenmonkey.online/kiosk/?utm=x#AbC-123_xyzAbC-123_xyz")
        #expect(link.url.absoluteString == "https://app.greenmonkey.online/kiosk#AbC-123_xyzAbC-123_xyz")
    }

    @Test(arguments: [
        ("not a url", KioskLink.Problem.notAURL),
        ("ios1", .notAURL),
        ("1234 5678", .pairingCode),
        ("12345678", .pairingCode),
        ("https://app.greenmonkey.online/kiosk#12345678", .pairingCode),
        ("https://app.greenmonkey.online/kiosk#ios1", .invalidToken),
        ("https://app.greenmonkey.online/kiosk#short", .invalidToken),
        ("https://app.greenmonkey.online/kiosk#AbC-123_xyzAbC-123_xyzC", .invalidToken),
        ("https://app.greenmonkey.online/kiosk#AbC-123_xyzAbC-123_xyzA!", .invalidToken),
        ("https://app.greenmonkey.online/kiosk#AbC-123_xyzAbC-123_xyzA%20", .invalidToken),
        ("ftp://app.greenmonkey.online/kiosk#AbC-123_xyzAbC-123_xyz", .notAURL),
        ("http://app.greenmonkey.online/kiosk#AbC-123_xyzAbC-123_xyz", .insecure),
        ("https://app.greenmonkey.online/qr#AbC-123_xyzAbC-123_xyz", .notAKiosk),
        ("https://app.greenmonkey.online/app", .notAKiosk),
        ("https://app.greenmonkey.online/kiosk/eyJhbGciOi.signed", .legacy),
        ("https://app.greenmonkey.online/kiosk", .missingToken),
        ("https://app.greenmonkey.online/kiosk#", .missingToken),
    ])
    func rejects(raw: String, problem: KioskLink.Problem) {
        #expect(KioskLink.parse(raw) == .failure(problem))
    }

    @Test(arguments: ["http://localhost:5173/kiosk#AbC-123_xyzAbC-123_xyz", "http://ipad-dev.local/kiosk#AbC-123_xyzAbC-123_xyz", "http://192.168.1.20:3000/kiosk#AbC-123_xyzAbC-123_xyz"])
    func allowsPlainHTTPOnlyOnTheLocalNetwork(raw: String) throws {
        #expect(try parse(raw).scheme == "http")
    }

    @Test func navigationStaysOnTheKioskPage() throws {
        let link = try parse("https://app.greenmonkey.online/kiosk#AbC-123_xyzAbC-123_xyz")
        #expect(link.allows(URL(string: "https://app.greenmonkey.online/kiosk#AbC-123_xyzAbC-123_xyz")!))
        #expect(link.allows(URL(string: "https://app.greenmonkey.online/kiosk#other")!))
        #expect(link.allows(URL(string: "about:blank")!))
        #expect(!link.allows(URL(string: "https://app.greenmonkey.online/app")!))
        #expect(!link.allows(URL(string: "https://app.greenmonkey.online/legal/privacidad")!))
        #expect(!link.allows(URL(string: "https://evil.example/kiosk#AbC-123_xyzAbC-123_xyz")!))
        #expect(!link.allows(URL(string: "http://app.greenmonkey.online/kiosk#AbC-123_xyzAbC-123_xyz")!))
        #expect(!link.allows(URL(string: "https://app.greenmonkey.online:8443/kiosk#AbC-123_xyzAbC-123_xyz")!))
        #expect(!link.allows(URL(string: "tel:5555555555")!))
    }
}
