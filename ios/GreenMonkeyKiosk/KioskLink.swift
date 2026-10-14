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
    }

    static func parse(_ raw: String) -> Result<KioskLink, Problem> {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
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
        guard let token = components.fragment, !token.isEmpty,
              !token.contains(where: { $0.isWhitespace })
        else { return .failure(.missingToken) }

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
}

extension KioskLink.Problem {
    var message: String {
        switch self {
        case .notAURL: "Eso no es un enlace."
        case .insecure: "El enlace debe empezar con https://."
        case .notAKiosk: "Ese enlace no es de un kiosco. Usa el de Configuración → Pedidos en línea → Agregar kiosco."
        case .legacy: "Ese enlace es de la versión anterior y ya no funciona. Crea uno nuevo en Configuración → Pedidos en línea."
        case .missingToken: "Al enlace le falta su código (la parte después de #). Cópialo completo."
        }
    }
}
