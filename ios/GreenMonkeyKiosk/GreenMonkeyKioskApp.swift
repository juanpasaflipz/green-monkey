import SwiftUI
import UIKit

@main
struct GreenMonkeyKioskApp: App {
    @State private var controller = KioskController()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            KioskRootView(controller: controller)
                .persistentSystemOverlays(.hidden)
                .statusBarHidden(true)
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            // The page also holds a screen wake lock; this covers the setup and offline screens.
            UIApplication.shared.isIdleTimerDisabled = phase == .active
        }
    }
}
