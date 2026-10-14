import LocalAuthentication
import SwiftUI
import UIKit

/// The staff way into the settings: hold two fingers anywhere for 3 seconds.
///
/// It is a window-level recognizer that never cancels touches, so unlike a hidden corner it takes
/// no part of the screen away from the kiosk page (whose header uses both top corners, and whose
/// restaurant name already has its own 3-second press for pairing).
struct StaffGestureInstaller: UIViewRepresentable {
    let action: @MainActor () -> Void

    func makeUIView(context: Context) -> InstallerView {
        let view = InstallerView()
        view.action = action
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: InstallerView, context: Context) {
        view.action = action
    }

    final class InstallerView: UIView, UIGestureRecognizerDelegate {
        var action: (@MainActor () -> Void)?
        private weak var installedOn: UIWindow?
        private lazy var recognizer: UILongPressGestureRecognizer = {
            let r = UILongPressGestureRecognizer(target: self, action: #selector(fire(_:)))
            r.numberOfTouchesRequired = 2
            r.minimumPressDuration = 3
            r.allowableMovement = 30
            r.cancelsTouchesInView = false
            r.delaysTouchesBegan = false
            r.delegate = self
            return r
        }()

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard let window, window !== installedOn else { return }
            installedOn?.removeGestureRecognizer(recognizer)
            window.addGestureRecognizer(recognizer)
            installedOn = window
        }

        @objc private func fire(_ r: UILongPressGestureRecognizer) {
            if r.state == .began { action?() }
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool { true }
    }
}

enum StaffAuthenticator {
    enum Outcome { case granted, noPasscode, denied }

    /// Asks for the iPad's own Face ID, Touch ID or passcode, so a guest who finds the gesture
    /// still cannot change the kiosk.
    @MainActor
    static func authenticate() async -> Outcome {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return (error as? LAError)?.code == .passcodeNotSet ? .noPasscode : .denied
        }
        do {
            let ok = try await context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: "Abrir la configuración del kiosco"
            )
            return ok ? .granted : .denied
        } catch {
            return .denied
        }
    }
}
