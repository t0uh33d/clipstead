import AppKit
import ClipsteadCore
import Network
import Observation
import OSLog
import ServiceManagement

/// State changes only: never clipboard content, codes or tokens. `log stream --predicate 'subsystem == "Clipstead"'`
private let log = Logger(subsystem: "Clipstead", category: "app")

/// App state and behaviour. Runs on the main actor; network uploads run in `UploadQueue`.
@MainActor @Observable
final class AppModel {
    // MARK: Preferences (UserDefaults; nothing secret. The device token is in the Keychain.)

    private(set) var server: URL? { didSet { defaults.set(server?.absoluteString, forKey: Keys.server) } }
    var consentGiven: Bool { didSet { defaults.set(consentGiven, forKey: Keys.consent) } }
    var resumeOnLaunch: Bool { didSet { defaults.set(resumeOnLaunch, forKey: Keys.resume) } }
    var pollInterval: Double {
        didSet {
            defaults.set(pollInterval, forKey: Keys.interval)
            if syncEnabled { monitor.start(interval: pollInterval) }
        }
    }
    var maxContentBytes: Int { didSet { defaults.set(maxContentBytes, forKey: Keys.maxBytes) } }
    /// Upload the formatted (rich text) version too, so pasting from the web app keeps bold, links, lists…
    var syncFormatting: Bool { didSet { defaults.set(syncFormatting, forKey: Keys.formatting) } }
    /// Upload copied images (screenshots, pictures), re-encoded to fit the size limit when needed.
    var syncImages: Bool { didSet { defaults.set(syncImages, forKey: Keys.images) } }
    var excludedApps: [String] { didSet { defaults.set(excludedApps, forKey: Keys.excluded) } }
    private(set) var username: String? { didSet { defaults.set(username, forKey: Keys.username) } }
    private(set) var deviceName: String? { didSet { defaults.set(deviceName, forKey: Keys.deviceName) } }
    private(set) var deviceID: String? { didSet { defaults.set(deviceID, forKey: Keys.deviceID) } }

    // MARK: Runtime state

    private(set) var syncEnabled = false
    private(set) var accessRevoked = false
    private(set) var isPairing = false
    private(set) var pairingMessage: String?
    private(set) var lastSyncAt: Date?
    private(set) var lastProblem: String?
    private(set) var lastSkip: SkipReason?
    private(set) var pendingCount = 0
    private(set) var droppedCount = 0
    private(set) var isOnline = true

    var isPaired: Bool { token != nil }

    static let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    static let platform: String = {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "macOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }()

    private enum Keys {
        static let server = "server", consent = "consentGiven", resume = "resumeOnLaunch", interval = "pollInterval"
        static let maxBytes = "maxContentBytes", excluded = "excludedApps", username = "username"
        static let deviceName = "deviceName", deviceID = "deviceID", wasSyncing = "wasSyncing", formatting = "syncFormatting"
        static let images = "syncImages"
        static let all = [server, consent, resume, interval, maxBytes, excluded, username, deviceName, deviceID, wasSyncing,
                          formatting, images]
    }

    private let defaults = UserDefaults.standard
    #if DEBUG
    private let keychain = Keychain(service: "Clipstead device token (debug build)")
    #else
    private let keychain = Keychain()
    #endif
    private let monitor = ClipboardMonitor()
    private let pathMonitor = NWPathMonitor()
    private var token: String?
    private var serverMaxBytes = 1024 * 1024
    private var queue: UploadQueue?
    private var lastUploadedHash: String?
    private var pairingTask: Task<Void, Never>?

    init() {
        server = defaults.string(forKey: Keys.server).flatMap(URL.init(string:))
        consentGiven = defaults.bool(forKey: Keys.consent)
        resumeOnLaunch = defaults.object(forKey: Keys.resume) as? Bool ?? true
        pollInterval = defaults.object(forKey: Keys.interval) as? Double ?? 1
        maxContentBytes = defaults.object(forKey: Keys.maxBytes) as? Int ?? 1024 * 1024
        syncFormatting = defaults.object(forKey: Keys.formatting) as? Bool ?? true
        syncImages = defaults.object(forKey: Keys.images) as? Bool ?? true
        excludedApps = defaults.stringArray(forKey: Keys.excluded) ?? ClipboardFilter.defaultExcludedApps
        username = defaults.string(forKey: Keys.username)
        deviceName = defaults.string(forKey: Keys.deviceName)
        deviceID = defaults.string(forKey: Keys.deviceID)
        if let server { token = keychain.read(account: server.absoluteString) }

        log.info("Launch: server \(self.server != nil), paired \(self.token != nil), consent \(self.consentGiven)")
        monitor.onChange = { [weak self] in self?.clipboardChanged() }
        observeSystem()
        rebuildQueue()
        if isPaired, consentGiven, resumeOnLaunch, defaults.bool(forKey: Keys.wasSyncing) { setSync(true) }
        Task { await refreshDevice() }
        #if DEBUG
        // End-to-end test hook (debug builds only): `Clipstead -E2EPairingCode CODE` pairs as if the code were typed
        // in Settings, then consents and starts syncing. See docs/development.md.
        if let code = defaults.string(forKey: "E2EPairingCode") { pair(code: code) }
        #endif
    }

    // MARK: Server and pairing

    func setServer(_ input: String) throws {
        let url = try ServerURL.parse(input)
        guard url != server else { return }
        // A credential belongs to one server. Forget it locally; revoke it from that server's web app.
        setSync(false)
        forgetCredential()
        accessRevoked = false
        consentGiven = false // Consent names the destination server, so a new server needs it again.
        server = url
    }

    func pair(code: String) {
        guard let server else { return }
        pairingTask?.cancel()
        isPairing = true
        accessRevoked = false
        pairingMessage = "Contacting the server…"
        let api = APIClient(server: server)
        pairingTask = Task {
            defer { isPairing = false }
            do {
                let claim = try await api.claimPairing(
                    code: code,
                    deviceName: Host.current().localizedName ?? "Mac",
                    platform: Self.platform,
                    appVersion: Self.appVersion
                )
                pairingMessage = "Waiting for you to approve this Mac in your browser…"
                var interval = claim.pollInterval
                while Date() < claim.expiresAt {
                    try await Task.sleep(for: .seconds(interval))
                    switch try await api.exchangePairing(pollToken: claim.pollToken) {
                    case .pending(let next):
                        interval = next
                    case .approved(let credential):
                        try keychain.save(credential.token, account: server.absoluteString)
                        token = credential.token
                        username = credential.username
                        deviceName = credential.deviceName
                        deviceID = credential.deviceID
                        pairingMessage = nil
                        rebuildQueue()
                        #if DEBUG
                        if defaults.string(forKey: "E2EPairingCode") != nil {
                            consentGiven = true
                            setSync(true)
                        }
                        #endif
                        return
                    }
                }
                pairingMessage = "The pairing code expired. Start again from the web app."
            } catch is CancellationError {
                pairingMessage = nil
            } catch APIError.rejected(let status, _, _) where status == 410 {
                pairingMessage = "Pairing was denied or expired. Start again from the web app."
            } catch APIError.rateLimited {
                pairingMessage = "Too many attempts. Wait a few minutes, then try again."
            } catch {
                pairingMessage = error.localizedDescription
            }
        }
    }

    func cancelPairing() {
        pairingTask?.cancel()
    }

    /// Unpairs this Mac: revokes the credential on the server when reachable, then deletes it locally.
    func unpair() async {
        setSync(false)
        if let server, let token { try? await APIClient(server: server).unpair(token: token) }
        forgetCredential()
        accessRevoked = false
    }

    /// "Clear local application state": unpair, forget settings, stop launching at login.
    func resetAll() async {
        await unpair()
        try? await SMAppService.mainApp.unregister()
        for key in Keys.all { defaults.removeObject(forKey: key) }
        server = nil
        consentGiven = false
        resumeOnLaunch = true
        pollInterval = 1
        maxContentBytes = 1024 * 1024
        syncFormatting = true
        syncImages = true
        excludedApps = ClipboardFilter.defaultExcludedApps
        lastSyncAt = nil
        lastProblem = nil
        lastSkip = nil
        droppedCount = 0
    }

    // MARK: Sync

    /// Turning sync on never uploads what is already on the clipboard; only later copies are considered.
    func setSync(_ on: Bool) {
        if on {
            guard isPaired, consentGiven, !syncEnabled else { return }
            syncEnabled = true
            lastUploadedHash = nil
            monitor.start(interval: pollInterval)
            log.info("Sync on")
        } else {
            if syncEnabled { log.info("Sync paused") }
            syncEnabled = false
            monitor.stop()
            let queue = queue
            Task { await queue?.clear() } // Pausing drops anything not yet uploaded.
            pendingCount = 0
        }
        defaults.set(syncEnabled, forKey: Keys.wasSyncing)
    }

    /// Explicitly uploads the current clipboard (subject to the same filters) and retries anything pending.
    func syncNow() {
        guard syncEnabled else { return }
        clipboardChanged()
        let queue = queue
        Task { await queue?.retryNow() }
    }

    func openWeb() {
        if let server { NSWorkspace.shared.open(server) }
    }

    private func clipboardChanged() {
        guard syncEnabled, let queue else { return }
        let pasteboard = NSPasteboard.general
        let maxBytes = min(maxContentBytes, serverMaxBytes)
        let filter = ClipboardFilter(excludedApps: Set(excludedApps), maxBytes: maxBytes)
        let decision = filter.evaluate(
            types: pasteboard.typeIdentifiers,
            sourceApp: NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
            lastUploadedHash: lastUploadedHash
        ) { pasteboard.string(forType: .string) }
        switch decision {
        case .upload(let text):
            lastUploadedHash = ClipboardFilter.hash(text)
            lastSkip = nil
            // Read only now that the filters allowed this copy. Too large with formatting: send the plain text.
            var html = syncFormatting ? pasteboard.formattedHTML : nil
            if let formatted = html, text.utf8.count + formatted.utf8.count > maxBytes { html = nil }
            Task {
                guard syncEnabled else { return } // Paused in the meantime: drop it.
                pendingCount = await queue.enqueue(text, html: html)
            }
        case .uploadImage:
            guard syncImages, let source = pasteboard.imageSource else {
                lastSkip = .noText
                return
            }
            Task {
                // Re-encoding a large image takes a moment: keep it off the main thread.
                let image = await Task.detached(priority: .utility) { ClipboardImage.fitting(source, maxBytes: maxBytes) }
                    .value
                guard let image else {
                    lastSkip = .tooLarge
                    return
                }
                let hash = ClipboardFilter.hash(image.data)
                guard hash != lastUploadedHash else {
                    lastSkip = .duplicate
                    return
                }
                lastUploadedHash = hash
                lastSkip = nil
                guard syncEnabled else { return } // Paused in the meantime: drop it.
                pendingCount = await queue.enqueue(image.label, image: image)
            }
        case .skip(let reason):
            lastSkip = reason
            log.info("Clipboard change skipped: \(reason.rawValue, privacy: .public)")
        }
    }

    private func rebuildQueue() {
        let old = queue
        Task { await old?.clear() }
        guard let server, let token else {
            queue = nil
            return
        }
        let api = APIClient(server: server)
        queue = UploadQueue(
            uploader: { item in
                do {
                    let receipt = try await api.upload(
                        text: item.text, html: item.html, image: item.image, idempotencyKey: item.id, token: token
                    )
                    return .uploaded(receipt.createdAt)
                } catch let error as APIError {
                    return error.uploadOutcome
                } catch {
                    return .retry(reason: "unexpected error", after: nil)
                }
            },
            listener: { [weak self] event, pending in
                await self?.handle(event, pending: pending)
            }
        )
    }

    private func handle(_ event: QueueEvent, pending: Int) {
        pendingCount = pending
        log.info("Upload queue: \(String(describing: event), privacy: .public), \(pending) waiting")
        switch event {
        case .uploaded(let date):
            lastSyncAt = date
            lastProblem = nil
        case .retrying(let reason):
            lastProblem = "Upload failed (\(reason)); retrying."
        case .waitingForNetwork:
            lastProblem = "Offline. Waiting for the network."
        case .dropped(let reason):
            droppedCount += 1
            lastProblem = "An item was not uploaded: \(Self.describe(reason))."
        case .unauthorized:
            credentialRejected()
        }
    }

    /// Checks the credential and refreshes device details. A revoked credential stops sync here too.
    private func refreshDevice() async {
        guard let server, let token else { return }
        do {
            let info = try await APIClient(server: server).deviceInfo(token: token)
            username = info.username
            deviceName = info.deviceName
            deviceID = info.deviceID
            serverMaxBytes = info.maxContentBytes
        } catch APIError.unauthorized {
            credentialRejected()
        } catch {
            // Offline or server trouble: keep the credential and try again later.
        }
    }

    private func credentialRejected() {
        log.notice("Device credential rejected; pairing again is required")
        setSync(false)
        forgetCredential()
        accessRevoked = true
    }

    private func forgetCredential() {
        pairingTask?.cancel()
        if let server { keychain.delete(account: server.absoluteString) }
        token = nil
        username = nil
        deviceName = nil
        deviceID = nil
        rebuildQueue()
    }

    private static func describe(_ reason: String) -> String {
        switch reason {
        case "content_too_large": "larger than the server accepts"
        case "storage_quota_exceeded": "your storage quota on the server is full"
        case "too_old": "it waited too long for a connection"
        case "queue_full": "too many items were waiting"
        default: reason.replacingOccurrences(of: "_", with: " ")
        }
    }

    // MARK: System events

    private func observeSystem() {
        _ = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                let queue = self?.queue
                Task { await queue?.retryNow() }
                Task { await self?.refreshDevice() }
            }
        }
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in self?.networkChanged(online: online) }
        }
        pathMonitor.start(queue: DispatchQueue(label: "Clipstead.network"))
    }

    private func networkChanged(online: Bool) {
        isOnline = online
        if online {
            let queue = queue
            Task { await queue?.retryNow() }
        }
    }

    // MARK: Presentation

    var statusText: String {
        if server == nil { return "Not set up" }
        if accessRevoked { return "Access revoked. Pair this Mac again" }
        if !isPaired { return isPairing ? "Pairing…" : "Not paired" }
        if !syncEnabled { return "Sync paused" }
        if !isOnline { return "Offline. Uploads will resume" }
        return pendingCount > 0 ? "Syncing (\(pendingCount) waiting)" : "Syncing"
    }

    var menuIcon: String {
        if accessRevoked { return "exclamationmark.triangle" }
        return syncEnabled ? "doc.on.clipboard.fill" : "doc.on.clipboard"
    }

    var lastSyncText: String {
        lastSyncAt.map { $0.formatted(.relative(presentation: .named)) } ?? "never"
    }

    /// Support details with no clipboard content and no credentials.
    var diagnostics: String {
        let paired = isPaired ? "yes, as \(username ?? "?") (device \(deviceID ?? "?"))" : (accessRevoked ? "no (access revoked)" : "no")
        return """
        Clipstead \(Self.appVersion) on \(Self.platform)
        Server: \(server?.absoluteString ?? "not set")
        Paired: \(paired)
        Sync: \(syncEnabled ? "on" : "paused"), every \(pollInterval)s, up to \(maxContentBytes) bytes, formatting \(syncFormatting ? "on" : "off"), images \(syncImages ? "on" : "off")
        Network: \(isOnline ? "online" : "offline")
        Last upload: \(lastSyncAt.map { $0.formatted(.iso8601) } ?? "never")
        Waiting: \(pendingCount), not uploaded: \(droppedCount)
        Last skipped: \(lastSkip?.rawValue ?? "none")
        Last problem: \(lastProblem ?? "none")
        Excluded apps: \(excludedApps.count)
        """
    }

    /// Copies diagnostics, marked auto-generated so Clipstead itself does not upload them.
    func copyDiagnostics() {
        let pasteboard = NSPasteboard.general
        let marker = NSPasteboard.PasteboardType("org.nspasteboard.AutoGeneratedType")
        pasteboard.declareTypes([.string, marker], owner: nil)
        pasteboard.setString(diagnostics, forType: .string)
        pasteboard.setData(Data(), forType: marker)
    }
}

/// Polls the pasteboard's change count. Cheap: reading `changeCount` does not touch clipboard data.
@MainActor
final class ClipboardMonitor {
    var onChange: (() -> Void)?
    private var task: Task<Void, Never>?
    private var lastChangeCount = 0

    /// Starts polling. Whatever is on the clipboard now counts as already seen and is never uploaded.
    func start(interval: TimeInterval) {
        task?.cancel()
        lastChangeCount = NSPasteboard.general.changeCount
        task = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(interval), tolerance: .seconds(interval / 5))
                guard let self, !Task.isCancelled else { return }
                // A changed count may cover several copies; only the latest content is visible, by design.
                let count = NSPasteboard.general.changeCount
                if count != lastChangeCount {
                    lastChangeCount = count
                    onChange?()
                }
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }
}
