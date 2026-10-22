import Foundation

/// A Green Monkey kiosk link: `https://<host>/kiosk#<token>`.
///
/// The token lives in the fragment and is a bearer secret (docs/PUBLIC_ORDERING.md §2), so it is
/// stored in the Keychain and never shown whole on screen.
struct KioskLink: Equatable, Sendable {
    let url: URL
    let scheme: String
    let host: String
    let port: Int?
    let token: String

    enum Problem: Error, Equatable {
        case notAURL
        case insecure
        case notAKiosk
        case legacy
        case missingToken
        case invalidToken
        case pairingCode
    }

    static func parse(_ raw: String) -> Result<KioskLink, Problem> {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if isPairingCode(trimmed) { return .failure(.pairingCode) }
        guard let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(), !host.isEmpty
        else { return .failure(.notAURL) }

        switch scheme {
        case "https": break
        case "http" where isLocal(host): break
        case "http": return .failure(.insecure)
        default: return .failure(.notAURL)
        }

        // Old 24 h signed paths (`/kiosk/<signed>`) no longer work (§2, "Legacy links").
        if components.path.hasPrefix("/kiosk/"), components.path.count > "/kiosk/".count {
            return .failure(.legacy)
        }
        guard components.path == "/kiosk" || components.path == "/kiosk/" else {
            return .failure(.notAKiosk)
        }
        guard let token = components.fragment, !token.isEmpty
        else { return .failure(.missingToken) }
        if isPairingCode(token) { return .failure(.pairingCode) }
        // Match shared/public-ordering.ts PUBLIC_TOKEN: 16 random bytes encoded
        // as 22 base64url characters. Accepting a station name or pairing code
        // here used to persist a link that the web page immediately rejected.
        guard token.range(of: "^[A-Za-z0-9_-]{22}$", options: .regularExpression) != nil
        else { return .failure(.invalidToken) }

        var clean = URLComponents()
        clean.scheme = scheme
        clean.host = host
        clean.port = components.port
        clean.path = "/kiosk"
        clean.fragment = token
        guard let url = clean.url else { return .failure(.notAURL) }
        return .success(KioskLink(url: url, scheme: scheme, host: host, port: components.port, token: token))
    }

    /// Whether a main-frame navigation may happen inside the kiosk: only this link's own page.
    /// The kiosk page renders no navigational link (§2), so anything else is a way out.
    func allows(_ target: URL) -> Bool {
        let scheme = target.scheme?.lowercased()
        if scheme == "about" { return true }
        return scheme == self.scheme
            && target.host?.lowercased() == host
            && target.port == port
            && (target.path == "/kiosk" || target.path == "/kiosk/")
    }

    /// `app.greenmonkey.online/kiosk · ••••3F9A`, for staff screens.
    var maskedDescription: String {
        let place = port.map { "\(host):\($0)" } ?? host
        return "\(place)/kiosk · ••••\(token.suffix(4))"
    }

    private static func isLocal(_ host: String) -> Bool {
        host == "localhost" || host.hasSuffix(".local") || host.allSatisfy { $0.isNumber || $0 == "." }
    }

    private static func isPairingCode(_ value: String) -> Bool {
        let compact = value.filter { !$0.isWhitespace }
        return compact.range(of: "^[0-9]{8}$", options: .regularExpression) != nil
    }
}

extension KioskLink.Problem {
    var message: String {
        switch self {
        case .notAURL: "Pega el enlace completo del kiosco (https://…/kiosk#…), no su nombre ni el código de vinculación."
        case .insecure: "El enlace debe empezar con https://."
        case .notAKiosk: "Ese enlace no es de un kiosco. Usa el de Configuración → Pedidos en línea → Agregar kiosco."
        case .legacy: "Ese enlace es de la versión anterior y ya no funciona. Crea uno nuevo en Configuración → Pedidos en línea."
        case .missingToken: "Al enlace le falta su código (la parte después de #). Cópialo completo."
        case .invalidToken: "El enlace del kiosco está incompleto o no es válido. Copia el enlace completo de Pedidos en línea, incluida la parte después de #."
        case .pairingCode: "Ese es el código de vinculación de 8 dígitos. Primero pega el enlace completo del kiosco. Cuando abra el menú, mantén presionado el nombre del restaurante 3 segundos → Configurar este kiosco e ingresa el código allí."
        }
    }
}
