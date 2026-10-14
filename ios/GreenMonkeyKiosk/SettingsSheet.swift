import SwiftUI

/// Staff only: opened by the two-finger, 3-second hold after the iPad's own authentication.
struct SettingsSheet: View {
    @Bindable var controller: KioskController
    let noPasscode: Bool
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @State private var problem: String?
    @State private var scannerOpen = false

    var body: some View {
        NavigationStack {
            Form {
                if noPasscode {
                    Section {
                        Label("Este iPad no tiene código. Cualquiera que conozca el gesto puede abrir esta pantalla. Ponle uno en Ajustes → Face ID y código.", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }

                Section {
                    LabeledContent("Enlace actual", value: controller.link?.maskedDescription ?? "Sin configurar")
                    LabeledContent("Estado", value: status)
                    if let error = controller.lastError {
                        LabeledContent("Último error", value: error)
                    }
                    Button("Recargar kiosco") {
                        controller.start()
                        dismiss()
                    }
                } header: {
                    Text("Kiosco")
                }

                Section {
                    if QRScannerSheet.isAvailable {
                        Button {
                            scannerOpen = true
                        } label: {
                            Label("Escanear código QR", systemImage: "qrcode.viewfinder")
                        }
                    }
                    PasteButton(payloadType: String.self) { strings in
                        if let raw = strings.first { use(raw) }
                    }
                    TextField("https://app.greenmonkey.online/kiosk#…", text: $draft)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .onSubmit { use(draft) }
                    if let problem {
                        Text(problem).foregroundStyle(.red)
                    }
                } header: {
                    Text("Cambiar enlace")
                } footer: {
                    Text("El enlace se crea en la caja: Configuración → Pedidos en línea → Agregar kiosco (o «Reemplazar» en un kiosco existente). Después, vincula la tableta: mantén presionado el nombre del restaurante 3 segundos → «Configurar este kiosco».")
                }

                Section {
                    Text("Para que nadie salga de la app, activa Acceso guiado: Ajustes → Accesibilidad → Acceso guiado. Abre Kiosco, presiona tres veces el botón superior y toca Iniciar. En Opciones, apaga los botones de encendido y volumen; deja el teclado encendido.")
                        .font(.callout)
                } header: {
                    Text("Bloqueo")
                }

                Section {
                    LabeledContent("Versión", value: version)
                }
            }
            .navigationTitle("Configuración del kiosco")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Listo") { dismiss() }
                }
            }
            .fullScreenCover(isPresented: $scannerOpen) {
                QRScannerSheet { link in apply(link) }
            }
        }
    }

    private var status: String {
        switch controller.phase {
        case .unconfigured: "Sin configurar"
        case .connecting: "Conectando…"
        case .waiting: "Sin conexión, reintentando"
        case .ready: "En línea"
        }
    }

    private var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(short) (\(build))"
    }

    private func use(_ raw: String) {
        switch KioskLink.parse(raw) {
        case .success(let link): apply(link)
        case .failure(let p): problem = p.message
        }
    }

    private func apply(_ link: KioskLink) {
        do {
            try controller.configure(link)
            dismiss()
        } catch {
            problem = "No se pudo guardar el enlace en este iPad."
        }
    }
}
