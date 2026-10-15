import Foundation

public struct PendingUpload: Equatable, Sendable {
    /// Also the server-side idempotency key, so every retry of this item is the same upload.
    public let id: String
    public let text: String
    /// Optional formatted version (rich text) as HTML.
    public let html: String?
    /// Set for image entries; `text` is then the image's label.
    public let image: ClipboardImage?
    public let queuedAt: Date
}

public enum UploadOutcome: Equatable, Sendable {
    case uploaded(Date)
    /// Transient failure: try again after `after` seconds, or after the queue's backoff.
    case retry(reason: String, after: TimeInterval?)
    /// No network: wait without using up attempts.
    case offline
    /// The server refused this item; retrying cannot help.
    case rejected(reason: String)
    /// The device credential is no longer valid.
    case unauthorized
}

public enum QueueEvent: Equatable, Sendable {
    case uploaded(Date)
    case retrying(reason: String)
    case waitingForNetwork
    case dropped(reason: String)
    case unauthorized
}

extension APIError {
    /// How the upload queue should treat this failure.
    public var uploadOutcome: UploadOutcome {
        switch self {
        case .unauthorized: .unauthorized
        case .rateLimited(let after): .retry(reason: "rate limited", after: after)
        case .rejected(_, let code, _): .rejected(reason: code)
        case .server(let status): .retry(reason: "server error \(status)", after: nil)
        case .network(let code) where Self.offlineCodes.contains(code): .offline
        case .network: .retry(reason: "network error", after: nil)
        case .invalidResponse: .retry(reason: "unexpected response", after: nil)
        }
    }

    static let offlineCodes: Set<URLError.Code> = [
        .notConnectedToInternet, .networkConnectionLost, .cannotFindHost, .cannotConnectToHost,
        .dnsLookupFailed, .dataNotAllowed, .internationalRoamingOff,
    ]
}

/// A bounded, serial upload queue with retries.
///
/// - One upload at a time, oldest first. When full, the oldest item is dropped.
/// - Transient failures back off exponentially with jitter, up to `maxAttempts`; then the item is dropped.
/// - Offline waits do not use up attempts, but items older than `maxAge` are dropped rather than uploaded late.
/// - `clear()` (pause) empties the queue and cancels the request in flight.
/// - In memory only: nothing copied is written to disk, and pending items are lost when the app quits.
public actor UploadQueue {
    public typealias Uploader = @Sendable (PendingUpload) async -> UploadOutcome
    public typealias Listener = @Sendable (QueueEvent, _ pending: Int) async -> Void

    public struct Policy: Sendable {
        public var capacity = 20
        public var maxAttempts = 8
        public var baseDelay: TimeInterval = 1
        public var maxDelay: TimeInterval = 120
        public var offlineRecheck: TimeInterval = 60
        public var maxAge: TimeInterval = 3600
        public init() {}
    }

    private let policy: Policy
    private let uploader: Uploader
    private let listener: Listener
    private var items: [PendingUpload] = []
    private var attempts = 0
    private var attemptsFor: String?
    private var worker: Task<Void, Never>?
    private var sleeper: Task<Void, Never>?

    public init(policy: Policy = Policy(), uploader: @escaping Uploader, listener: @escaping Listener) {
        self.policy = policy
        self.uploader = uploader
        self.listener = listener
    }

    public var count: Int { items.count }

    /// Queues text for upload and returns the number of pending items.
    @discardableResult
    public func enqueue(_ text: String, html: String? = nil, image: ClipboardImage? = nil, now: Date = Date()) async -> Int {
        if items.count >= policy.capacity {
            items.removeFirst()
            await emit(.dropped(reason: "queue_full"))
        }
        items.append(PendingUpload(id: UUID().uuidString, text: text, html: html, image: image, queuedAt: now))
        startIfNeeded()
        return items.count
    }

    /// Drops everything pending and cancels the upload in flight.
    public func clear() {
        items.removeAll()
        worker?.cancel()
        sleeper?.cancel()
    }

    /// Ends any backoff or offline wait now, e.g. when the network returns or the Mac wakes.
    public func retryNow() {
        sleeper?.cancel()
    }

    /// Exponential backoff with jitter: baseDelay × 2^(attempt − 1), capped at maxDelay, scaled by 50–100%.
    public static func backoff(attempt: Int, policy: Policy, jitter: Double = .random(in: 0.5...1)) -> TimeInterval {
        min(policy.maxDelay, policy.baseDelay * pow(2, Double(max(0, attempt - 1)))) * jitter
    }

    private func startIfNeeded() {
        guard worker == nil, !items.isEmpty else { return }
        worker = Task { await drain() }
    }

    private func drain() async {
        while let item = items.first, !Task.isCancelled {
            if Date().timeIntervalSince(item.queuedAt) > policy.maxAge {
                remove(item)
                await emit(.dropped(reason: "too_old"))
                continue
            }
            if attemptsFor != item.id {
                attemptsFor = item.id
                attempts = 0
            }
            let outcome = await uploader(item)
            if Task.isCancelled { break }
            switch outcome {
            case .uploaded(let date):
                remove(item)
                await emit(.uploaded(date))
            case .rejected(let reason):
                remove(item)
                await emit(.dropped(reason: reason))
            case .unauthorized:
                items.removeAll()
                await emit(.unauthorized)
            case .offline:
                await emit(.waitingForNetwork)
                await pause(policy.offlineRecheck)
            case .retry(let reason, let after):
                attempts += 1
                if attempts >= policy.maxAttempts {
                    remove(item)
                    await emit(.dropped(reason: reason))
                } else {
                    await emit(.retrying(reason: reason))
                    await pause(after ?? Self.backoff(attempt: attempts, policy: policy))
                }
            }
        }
        worker = nil
        startIfNeeded() // Items queued after a clear() while this worker was winding down.
    }

    private func pause(_ seconds: TimeInterval) async {
        let task = Task { _ = try? await Task.sleep(for: .seconds(seconds)) }
        sleeper = task
        await task.value
        sleeper = nil
    }

    private func remove(_ item: PendingUpload) {
        items.removeAll { $0.id == item.id }
    }

    private func emit(_ event: QueueEvent) async {
        await listener(event, items.count)
    }
}
