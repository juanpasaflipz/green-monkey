import Foundation
import Testing
@testable import GreenMonkeyKiosk

struct KioskLinkTests {
    private func parse(_ raw: String) throws -> KioskLink {
        try KioskLink.parse(raw).get()
    }

    @Test func acceptsAKioskLinkAndNormalizesIt() throws {
        let link = try parse("  HTTPS://App.GreenMonkey.online/kiosk#AbC-123_xyz \n")
        #expect(link.url.absoluteString == "https://app.greenmonkey.online/kiosk#AbC-123_xyz")
        #expect(link.token == "AbC-123_xyz")
        #expect(link.maskedDescription == "app.greenmonkey.online/kiosk · ••••_xyz")
    }

    @Test func dropsAQueryAndATrailingSlash() throws {
        let link = try parse("https://app.greenmonkey.online/kiosk/?utm=x#tok")
        #expect(link.url.absoluteString == "https://app.greenmonkey.online/kiosk#tok")
    }

    @Test(arguments: [
        ("not a url", KioskLink.Problem.notAURL),
        ("ftp://app.greenmonkey.online/kiosk#tok", .notAURL),
        ("http://app.greenmonkey.online/kiosk#tok", .insecure),
        ("https://app.greenmonkey.online/qr#tok", .notAKiosk),
        ("https://app.greenmonkey.online/app", .notAKiosk),
        ("https://app.greenmonkey.online/kiosk/eyJhbGciOi.signed", .legacy),
        ("https://app.greenmonkey.online/kiosk", .missingToken),
        ("https://app.greenmonkey.online/kiosk#", .missingToken),
    ])
    func rejects(raw: String, problem: KioskLink.Problem) {
        #expect(KioskLink.parse(raw) == .failure(problem))
    }

    @Test(arguments: ["http://localhost:5173/kiosk#tok", "http://ipad-dev.local/kiosk#tok", "http://192.168.1.20:3000/kiosk#tok"])
    func allowsPlainHTTPOnlyOnTheLocalNetwork(raw: String) throws {
        #expect(try parse(raw).scheme == "http")
    }

    @Test func navigationStaysOnTheKioskPage() throws {
        let link = try parse("https://app.greenmonkey.online/kiosk#tok")
        #expect(link.allows(URL(string: "https://app.greenmonkey.online/kiosk#tok")!))
        #expect(link.allows(URL(string: "https://app.greenmonkey.online/kiosk#other")!))
        #expect(link.allows(URL(string: "about:blank")!))
        #expect(!link.allows(URL(string: "https://app.greenmonkey.online/app")!))
        #expect(!link.allows(URL(string: "https://app.greenmonkey.online/legal/privacidad")!))
        #expect(!link.allows(URL(string: "https://evil.example/kiosk#tok")!))
        #expect(!link.allows(URL(string: "http://app.greenmonkey.online/kiosk#tok")!))
        #expect(!link.allows(URL(string: "https://app.greenmonkey.online:8443/kiosk#tok")!))
        #expect(!link.allows(URL(string: "tel:5555555555")!))
    }
}
