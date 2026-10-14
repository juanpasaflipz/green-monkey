import SwiftUI
import WebKit

struct KioskRootView: View {
    @Bindable var controller: KioskController
    @State private var settingsOpen = false
    @State private var scannerOpen = false
    @State private var noPasscode = false

    var body: some View {
        ZStack {
            Color("BrandGreen").ignoresSafeArea()

            if controller.link != nil {
                WebView(controller.page)
                    .webViewBackForwardNavigationGestures(.disabled)
                    .webViewMagnificationGestures(.disabled)
                    // The page asks for fullscreen on "Toca para ordenar"; the app already is.
                    .webViewElementFullscreenBehavior(.disabled)
                    .webViewLinkPreviews(.disabled)
                    .ignoresSafeArea()
                    .opacity(controller.phase == .ready ? 1 : 0)
            }

            switch controller.phase {
            case .unconfigured:
                SetupView(
                    scan: QRScannerSheet.isAvailable ? { scannerOpen = true } : nil,
                    paste: { link in apply(link) }
                )
            case .connecting, .waiting:
                ConnectingView(phase: controller.phase)
            case .ready:
                EmptyView()
            }
        }
        .background(StaffGestureInstaller { Task { await openSettings() } })
        .onAppear { controller.start() }
        .sheet(isPresented: $settingsOpen) {
            SettingsSheet(controller: controller, noPasscode: noPasscode)
        }
        .fullScreenCover(isPresented: $scannerOpen) {
            QRScannerSheet { link in apply(link) }
        }
    }

    private func apply(_ link: KioskLink) {
        try? controller.configure(link)
    }

    private func openSettings() async {
        guard !settingsOpen, !scannerOpen else { return }
        switch await StaffAuthenticator.authenticate() {
        case .granted: noPasscode = false; settingsOpen = true
        case .noPasscode: noPasscode = true; settingsOpen = true
        case .denied: break
        }
    }
}

private struct BrandMark: View {
    var size: CGFloat = 120

    var body: some View {
        Image("BrandMark")
            .resizable()
            .frame(width: size, height: size)
            .clipShape(.rect(cornerRadius: size * 0.22))
            .accessibilityHidden(true)
    }
}

/// First run: no link yet. Staff-facing, so it explains where the link comes from.
private struct SetupView: View {
    let scan: (() -> Void)?
    let paste: (KioskLink) -> Void
    @State private var problem: String?

    var body: some View {
        VStack(spacing: 28) {
            BrandMark()
            Text("Configura este kiosco")
                .font(.largeTitle.bold())
            Text("En la caja, abre Configuración → Pedidos en línea → Agregar kiosco. Green Monkey muestra un código QR una sola vez: escanéalo con este iPad.")
                .font(.title3)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 620)

            VStack(spacing: 14) {
                if let scan {
                    Button(action: scan) {
                        Label("Escanear código QR", systemImage: "qrcode.viewfinder")
                            .frame(maxWidth: 360)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.white)
                    .foregroundStyle(Color("BrandGreen"))
                }
                PasteButton(payloadType: String.self) { strings in
                    guard let raw = strings.first else { return }
                    switch KioskLink.parse(raw) {
                    case .success(let link): paste(link)
                    case .failure(let p): problem = p.message
                    }
                }
                .buttonBorderShape(.capsule)
            }
            .controlSize(.extraLarge)

            if let problem {
                Text(problem)
                    .font(.headline)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 560)
            }
        }
        .foregroundStyle(.white)
        .padding(40)
    }
}

/// Shown until the kiosk page has loaded once. Guest-facing: it never shows technical detail.
private struct ConnectingView: View {
    let phase: KioskController.Phase

    var body: some View {
        VStack(spacing: 24) {
            BrandMark(size: 96)
            switch phase {
            case .waiting(let retryAt):
                Text("Este kiosco no está disponible por ahora.")
                    .font(.largeTitle.bold())
                Text("Pide en caja.")
                    .font(.title)
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let seconds = max(0, Int(retryAt.timeIntervalSince(context.date).rounded(.up)))
                    Text(seconds > 0 ? "Reintentando en \(seconds) s" : "Reintentando…")
                        .font(.headline)
                        .monospacedDigit()
                        .opacity(0.8)
                }
            default:
                ProgressView()
                    .controlSize(.large)
                    .tint(.white)
                Text("Conectando…")
                    .font(.title2.weight(.medium))
            }
        }
        .foregroundStyle(.white)
        .multilineTextAlignment(.center)
        .padding(40)
    }
}
