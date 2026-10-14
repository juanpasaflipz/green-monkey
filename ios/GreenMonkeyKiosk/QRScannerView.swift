import SwiftUI
import VisionKit

/// Scans the kiosk link's QR code from the one-time reveal on the caja
/// (Configuración → Pedidos en línea → Agregar kiosco), so nobody types a token.
struct QRScannerSheet: View {
    let onLink: (KioskLink) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var problem: String?

    static var isAvailable: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                QRScanner { payload in
                    switch KioskLink.parse(payload) {
                    case .success(let link):
                        onLink(link)
                        dismiss()
                        return true
                    case .failure(let p):
                        problem = p.message
                        return false
                    }
                } onUnavailable: { message in
                    problem = message
                }
                .ignoresSafeArea()

                Text(problem ?? "Apunta la cámara al código QR del kiosco en la pantalla de la caja.")
                    .font(.title3.weight(.medium))
                    .multilineTextAlignment(.center)
                    .padding(20)
                    .frame(maxWidth: 560)
                    .background(.regularMaterial, in: .rect(cornerRadius: 20))
                    .padding(32)
            }
            .navigationTitle("Escanear código QR")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
            }
        }
    }
}

private struct QRScanner: UIViewControllerRepresentable {
    /// Returns true when the payload was accepted and scanning should stop.
    let onPayload: @MainActor (String) -> Bool
    let onUnavailable: @MainActor (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        do {
            try scanner.startScanning()
        } catch {
            onUnavailable("La cámara no está disponible. Revisa en Ajustes → Privacidad → Cámara que Kiosco tenga permiso, o pega el enlace.")
        }
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onPayload: onPayload) }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onPayload: @MainActor (String) -> Bool
        private var done = false

        init(onPayload: @escaping @MainActor (String) -> Bool) {
            self.onPayload = onPayload
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            guard !done else { return }
            for case .barcode(let code) in addedItems {
                guard let payload = code.payloadStringValue else { continue }
                if onPayload(payload) {
                    done = true
                    dataScanner.stopScanning()
                    return
                }
            }
        }
    }
}
