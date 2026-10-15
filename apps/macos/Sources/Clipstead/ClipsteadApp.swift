import ClipsteadCore
import ServiceManagement
import SwiftUI
import UniformTypeIdentifiers

@main
struct ClipsteadApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model)
        } label: {
            Image(systemName: model.menuIcon)
                .accessibilityLabel("Clipstead: \(model.statusText)")
        }
        Settings {
            SettingsView(model: model)
        }
    }
}

struct MenuContent: View {
    let model: AppModel
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Text(model.statusText)
        if let host = model.server?.host() { Text("Server: \(host)") }
        if let device = model.deviceName, let user = model.username { Text("\(device) · \(user)") }
        Text("Last upload: \(model.lastSyncText)")
        Divider()
        if model.isPaired {
            Button(model.syncEnabled ? "Pause Sync" : "Resume Sync") {
                if model.syncEnabled || model.consentGiven { model.setSync(!model.syncEnabled) } else { showSettings() }
            }
            .keyboardShortcut("p")
            Button("Sync Now") { model.syncNow() }
                .disabled(!model.syncEnabled)
        } else {
            Button("Pair This Mac…") { showSettings() }
        }
        Button("Open Web Clipboard") { model.openWeb() }
            .disabled(model.server == nil)
        Divider()
        Button("Settings…") { showSettings() }
            .keyboardShortcut(",")
        Button("Quit Clipstead") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }

    private func showSettings() {
        NSApp.activate()
        openSettings()
    }
}

struct SettingsView: View {
    let model: AppModel

    var body: some View {
        TabView {
            AccountTab(model: model).tabItem { Label("Account", systemImage: "person.crop.circle") }
            PrivacyTab(model: model).tabItem { Label("Privacy", systemImage: "hand.raised") }
            GeneralTab(model: model).tabItem { Label("General", systemImage: "gearshape") }
            DiagnosticsTab(model: model).tabItem { Label("Diagnostics", systemImage: "stethoscope") }
        }
        .frame(width: 540, height: 520)
    }
}

struct AccountTab: View {
    @Bindable var model: AppModel
    @State private var serverInput = ""
    @State private var serverError: String?
    @State private var code = ""
    @State private var askConsent = false

    private var host: String { model.server?.host() ?? "your server" }

    var body: some View {
        Form {
            Section("Server") {
                HStack {
                    TextField("Address", text: $serverInput, prompt: Text("https://clipstead.example.workers.dev"))
                        .textContentType(.URL)
                        .onSubmit(saveServer)
                    Button("Save", action: saveServer)
                }
                if let serverError { Text(serverError).foregroundStyle(.red) }
                if model.server?.scheme == "http" {
                    Text("Development server: traffic to it is not encrypted.").foregroundStyle(.orange)
                }
            }

            Section("Pairing") {
                if model.isPaired {
                    LabeledContent("Account", value: model.username ?? "–")
                    LabeledContent("This Mac", value: model.deviceName ?? "–")
                    Button("Unpair This Mac", role: .destructive) { Task { await model.unpair() } }
                } else {
                    if model.accessRevoked {
                        Text("This Mac's access was revoked or expired. Pair it again to keep syncing.")
                            .foregroundStyle(.orange)
                    }
                    Text("In the web app, open Devices → Add a Mac, then enter the code it shows.")
                    HStack {
                        TextField("Pairing code", text: $code, prompt: Text("ABCD-EFGH"))
                            .onSubmit(pair)
                        if model.isPairing {
                            Button("Cancel") { model.cancelPairing() }
                        } else {
                            Button("Pair", action: pair)
                                .disabled(model.server == nil || code.isEmpty)
                        }
                    }
                    if let message = model.pairingMessage { Text(message).foregroundStyle(.secondary) }
                }
            }

            Section {
                Toggle("Sync clipboard to this server", isOn: Binding(
                    get: { model.syncEnabled },
                    set: { on in
                        if on, !model.consentGiven { askConsent = true } else { model.setSync(on) }
                    }
                ))
                .disabled(!model.isPaired)
            } header: {
                Text("Sync")
            } footer: {
                Text("While sync is on, text and images you copy are uploaded to \(host). Pause any time from the menu bar.")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onAppear { serverInput = model.server?.absoluteString ?? "" }
        .alert("Upload what you copy?", isPresented: $askConsent) {
            Button("Start Syncing") {
                model.consentGiven = true
                model.setSync(true)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("""
            While sync is on, text (with its formatting) and images you copy on this Mac are uploaded to \(host). \
            Anyone who controls that server or its database can see them. Clipstead skips content that password managers mark as confidential \
            and apps you exclude, but it cannot recognise every password or secret.
            """)
        }
    }

    private func saveServer() {
        do {
            try model.setServer(serverInput)
            serverInput = model.server?.absoluteString ?? serverInput
            serverError = nil
        } catch {
            serverError = error.localizedDescription
        }
    }

    private func pair() {
        guard !code.isEmpty else { return }
        model.pair(code: code)
    }
}

struct PrivacyTab: View {
    @Bindable var model: AppModel

    var body: some View {
        Form {
            Section {
                ForEach(model.excludedApps, id: \.self) { bundleID in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(appName(bundleID))
                            Text(bundleID).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Remove") { model.excludedApps.removeAll { $0 == bundleID } }
                    }
                }
                Button("Add App…", action: addApps)
            } header: {
                Text("Never sync copies made in these apps")
            } footer: {
                Text("""
                Clipstead checks which app is in front when it notices a copy. Apps that change the clipboard in the \
                background cannot be identified, so exclusions are best-effort.
                """)
                .foregroundStyle(.secondary)
            }

            Section("Content") {
                Picker("Largest item to sync", selection: $model.maxContentBytes) {
                    Text("16 KB").tag(16 * 1024)
                    Text("64 KB").tag(64 * 1024)
                    Text("256 KB").tag(256 * 1024)
                    Text("1 MB").tag(1024 * 1024)
                }
                Toggle("Keep formatting (rich text)", isOn: $model.syncFormatting)
                Toggle("Sync images", isOn: $model.syncImages)
                Text("""
                Formatting (bold, links, lists) is uploaded alongside the plain text, so pasting from the web app keeps \
                it. Images that do not fit the size limit are uploaded smaller. Files copied in Finder are never \
                uploaded, and items that password managers mark as confidential (the nspasteboard.org convention) are \
                always skipped.
                """)
                .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    private func appName(_ bundleID: String) -> String {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID)
            .map { FileManager.default.displayName(atPath: $0.path) } ?? bundleID
    }

    private func addApps() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.application]
        panel.allowsMultipleSelection = true
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        guard panel.runModal() == .OK else { return }
        for url in panel.urls {
            if let id = Bundle(url: url)?.bundleIdentifier, !model.excludedApps.contains(id) {
                model.excludedApps.append(id)
            }
        }
    }
}

struct GeneralTab: View {
    @Bindable var model: AppModel
    @State private var launchError: String?
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled

    var body: some View {
        Form {
            Toggle("Launch at login", isOn: Binding(
                get: { launchAtLogin },
                set: { on in
                    do {
                        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
                        launchError = nil
                    } catch {
                        launchError = error.localizedDescription
                    }
                    launchAtLogin = SMAppService.mainApp.status == .enabled
                }
            ))
            if let launchError { Text(launchError).foregroundStyle(.red) }
            Toggle("Resume syncing when Clipstead starts", isOn: $model.resumeOnLaunch)
            Picker("Check the clipboard every", selection: $model.pollInterval) {
                Text("0.5 seconds").tag(0.5)
                Text("1 second").tag(1.0)
                Text("2 seconds").tag(2.0)
                Text("5 seconds").tag(5.0)
            }
        }
        .formStyle(.grouped)
    }
}

struct DiagnosticsTab: View {
    let model: AppModel
    @State private var confirmReset = false

    var body: some View {
        Form {
            Section {
                Text(model.diagnostics)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
            } footer: {
                Text("Contains no clipboard content and no credentials.").foregroundStyle(.secondary)
            }
            HStack {
                Button("Copy Diagnostics") { model.copyDiagnostics() }
                Spacer()
                Button("Reset Clipstead…", role: .destructive) { confirmReset = true }
            }
        }
        .formStyle(.grouped)
        .confirmationDialog("Reset Clipstead?", isPresented: $confirmReset) {
            Button("Unpair and Reset", role: .destructive) { Task { await model.resetAll() } }
        } message: {
            Text("Unpairs this Mac (revoking its access if the server is reachable), deletes its credential from the Keychain and restores default settings.")
        }
    }
}
