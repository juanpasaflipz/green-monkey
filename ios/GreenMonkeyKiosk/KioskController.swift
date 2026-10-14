import Foundation
import Observation
import OSLog
import WebKit

private let log = Logger(subsystem: "online.greenmonkey.kiosk", category: "kiosk")

@MainActor
@Observable
final class KioskController {
    enum Phase: Equatable {
        case unconfigured
        case connecting
        /// The first load failed; the next try is at `retryAt`.
        case waiting(retryAt: Date)
        case ready
    }

    private(set) var link: KioskLink?
    private(set) var phase: Phase {
        didSet { if phase != oldValue { log.info("phase \(String(describing: self.phase), privacy: .public)") } }
    }
    private(set) var lastError: String?

    let page: WebPage
    private let policy: KioskNavigationPolicy
    private var loop: Task<Void, Never>?

    init() {
        let policy = KioskNavigationPolicy()
        var config = WebPage.Configuration()
        // Persistent, so the tablet's pairing cookie (`gm_kiosk`, 400 days) survives relaunches.
        config.websiteDataStore = .default()
        config.defaultNavigationPreferences.allowsContentJavaScript = true
        self.policy = policy
        self.page = WebPage(configuration: config, navigationDecider: policy)

        let stored = Self.provisionedLink() ?? KioskLinkStore.load()
        if let stored { try? KioskLinkStore.save(stored) }
        self.link = stored
        self.phase = stored == nil ? .unconfigured : .connecting
        policy.link = stored
    }

    /// A link pushed by an MDM as managed app configuration (`kioskURL`), which wins over the
    /// stored one so a fleet is re-pointed from the console. Debug builds also take the launch
    /// argument `-kioskURL <link>`.
    private static func provisionedLink() -> KioskLink? {
        let managed = UserDefaults.standard.dictionary(forKey: "com.apple.configuration.managed")
        var raw = managed?["kioskURL"] as? String
        #if DEBUG
        raw = raw ?? UserDefaults.standard.string(forKey: "kioskURL")
        #endif
        guard let raw, case .success(let link) = KioskLink.parse(raw) else { return nil }
        return link
    }

    func configure(_ link: KioskLink) throws {
        try KioskLinkStore.save(link)
        self.link = link
        policy.link = link
        start()
    }

    /// Loads the kiosk and keeps it loaded: retries a failed first load with backoff (the tablet
    /// often powers on before the network), and reloads when WebKit's content process dies.
    /// Once the page is up, the web app handles its own connection loss and retries.
    func start() {
        loop?.cancel()
        guard let link else { phase = .unconfigured; return }
        loop = Task { [weak self] in await self?.run(link) }
    }

    private func run(_ link: KioskLink) async {
        var backoff: Duration = .seconds(5)
        while !Task.isCancelled {
            phase = .connecting
            do {
                for try await event in page.load(link.url) {
                    log.debug("event \(String(describing: event), privacy: .public)")
                    if event == .finished { phase = .ready }
                }
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                lastError = error.localizedDescription
                log.error("load failed: \(String(describing: error), privacy: .private)")
                let seconds = backoff.components.seconds
                phase = .waiting(retryAt: .now.addingTimeInterval(TimeInterval(seconds)))
                try? await Task.sleep(for: backoff)
                backoff = min(backoff * 2, .seconds(60))
                continue
            }
            guard phase == .ready else { continue }
            backoff = .seconds(5)
            lastError = nil
            if await watchUntilTerminated() == false { return }
        }
    }

    /// Returns true when the content process died and the page needs a reload; false when the
    /// task was cancelled. Any other navigation error leaves the current page on screen: a
    /// reload there would throw away a guest's cart.
    private func watchUntilTerminated() async -> Bool {
        while !Task.isCancelled {
            do {
                for try await _ in page.navigations {}
                return false
            } catch WebPage.NavigationError.webContentProcessTerminated {
                lastError = "El contenido del kiosco se reinició."
                return true
            } catch is CancellationError {
                return false
            } catch {
                lastError = error.localizedDescription
            }
        }
        return false
    }
}

/// Keeps the web view on the kiosk page and turns server errors into retries.
@MainActor
final class KioskNavigationPolicy: WebPage.NavigationDeciding {
    var link: KioskLink?

    func decidePolicy(
        for action: WebPage.NavigationAction,
        preferences: inout WebPage.NavigationPreferences
    ) async -> WKNavigationActionPolicy {
        guard let link, let url = action.request.url else { return .cancel }
        return link.allows(url) ? .allow : .cancel
    }

    func decidePolicy(for response: WebPage.NavigationResponse) async -> WKNavigationResponsePolicy {
        // A 5xx from the edge (a deploy, an outage) would otherwise leave its error page on the
        // kiosk with nothing retrying it. Cancelling fails the load, and the controller retries.
        // Only the kiosk page itself gets here: the action policy cancels every other frame.
        if let http = response.response as? HTTPURLResponse, http.statusCode >= 500 {
            return .cancel
        }
        return .allow
    }
}
