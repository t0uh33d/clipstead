import XCTest
@testable import ClipsteadCore

/// Scripted uploader: returns the queued outcomes in order, then succeeds. Records every call.
private actor Script {
    var outcomes: [UploadOutcome]
    var calls: [PendingUpload] = []
    var delay: Duration?

    init(_ outcomes: [UploadOutcome] = [], delay: Duration? = nil) {
        self.outcomes = outcomes
        self.delay = delay
    }

    func next(_ item: PendingUpload) async -> UploadOutcome {
        calls.append(item)
        if let delay { try? await Task.sleep(for: delay) }
        return outcomes.isEmpty ? .uploaded(Date()) : outcomes.removeFirst()
    }
}

private actor Events {
    var list: [QueueEvent] = []
    func add(_ event: QueueEvent) { list.append(event) }
}

final class UploadQueueTests: XCTestCase {
    private func fastPolicy(_ change: (inout UploadQueue.Policy) -> Void = { _ in }) -> UploadQueue.Policy {
        var policy = UploadQueue.Policy()
        policy.baseDelay = 0.01
        policy.maxDelay = 0.05
        policy.offlineRecheck = 0.05
        change(&policy)
        return policy
    }

    private func makeQueue(_ script: Script, _ events: Events, policy: UploadQueue.Policy) -> UploadQueue {
        UploadQueue(policy: policy, uploader: { await script.next($0) }, listener: { event, _ in await events.add(event) })
    }

    private func eventually(timeout: TimeInterval = 3, _ condition: @escaping () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Condition not met within \(timeout)s", file: file, line: line)
    }

    func testUploadsOneAtATimeInOrder() async {
        let script = Script(delay: .milliseconds(20))
        let events = Events()
        let queue = makeQueue(script, events, policy: fastPolicy())
        await queue.enqueue("first", html: "<b>first</b>")
        await queue.enqueue("second")
        await eventually { await events.list.count == 2 }
        let calls = await script.calls
        XCTAssertEqual(calls.map(\.text), ["first", "second"])
        XCTAssertEqual(calls.map(\.html), ["<b>first</b>", nil])
        let count = await queue.count
        XCTAssertEqual(count, 0)
    }

    func testRetriesTransientFailuresWithTheSameIdempotencyKey() async {
        let script = Script([.retry(reason: "server error 503", after: nil), .offline])
        let events = Events()
        let queue = makeQueue(script, events, policy: fastPolicy())
        await queue.enqueue("flaky")
        await eventually { await events.list.contains { if case .uploaded = $0 { true } else { false } } }
        let calls = await script.calls
        XCTAssertEqual(calls.count, 3)
        XCTAssertEqual(Set(calls.map(\.id)).count, 1, "retries must reuse the idempotency key")
        let list = await events.list
        XCTAssertEqual(list.prefix(2), [.retrying(reason: "server error 503"), .waitingForNetwork])
    }

    func testGivesUpAfterMaxAttempts() async {
        let script = Script(Array(repeating: .retry(reason: "network error", after: nil), count: 10))
        let events = Events()
        let queue = makeQueue(script, events, policy: fastPolicy { $0.maxAttempts = 3 })
        await queue.enqueue("doomed")
        await eventually { await events.list.contains(.dropped(reason: "network error")) }
        let callCount = await script.calls.count
        XCTAssertEqual(callCount, 3)
    }

    func testDropsRejectedItemsWithoutRetryingAndContinues() async {
        let script = Script([.rejected(reason: "content_too_large")])
        let events = Events()
        let queue = makeQueue(script, events, policy: fastPolicy())
        await queue.enqueue("huge")
        await queue.enqueue("fine")
        await eventually { await events.list.count == 2 }
        let list = await events.list
        XCTAssertEqual(list.first, .dropped(reason: "content_too_large"))
        let texts = await script.calls.map(\.text)
        XCTAssertEqual(texts, ["huge", "fine"])
    }

    func testUnauthorizedStopsAndEmptiesTheQueue() async {
        let script = Script([.unauthorized], delay: .milliseconds(20))
        let events = Events()
        let queue = makeQueue(script, events, policy: fastPolicy())
        await queue.enqueue("a")
        await queue.enqueue("b")
        await queue.enqueue("c")
        await eventually { await events.list.contains(.unauthorized) }
        try? await Task.sleep(for: .milliseconds(100))
        let callCount = await script.calls.count
        let count = await queue.count
        XCTAssertEqual(callCount, 1)
        XCTAssertEqual(count, 0)
    }

    func testIsBoundedAndDropsTheOldestWhenFull() async {
        // The first item waits for a network that never returns, so the rest pile up.
        let script = Script(Array(repeating: .offline, count: 100))
        let events = Events()
        let queue = makeQueue(script, events, policy: fastPolicy { $0.capacity = 3; $0.offlineRecheck = 10 })
        for i in 0..<5 { await queue.enqueue("item \(i)") }
        let count = await queue.count
        XCTAssertEqual(count, 3)
        let drops = await events.list.filter { $0 == .dropped(reason: "queue_full") }.count
        XCTAssertEqual(drops, 2)
        await queue.clear()
    }

    func testClearCancelsTheUploadInFlightAndLaterItemsStillUpload() async {
        let script = Script(delay: .seconds(10))
        let events = Events()
        let queue = makeQueue(script, events, policy: fastPolicy())
        await queue.enqueue("copied before pause")
        await eventually { await script.calls.count == 1 }
        await queue.clear()
        let count = await queue.count
        XCTAssertEqual(count, 0)

        await script.setDelay(nil)
        await queue.enqueue("copied after resume")
        await eventually { await events.list.contains { if case .uploaded = $0 { true } else { false } } }
        let texts = await script.calls.map(\.text)
        XCTAssertEqual(texts, ["copied before pause", "copied after resume"])
        let uploaded = await events.list.filter { if case .uploaded = $0 { true } else { false } }.count
        XCTAssertEqual(uploaded, 1, "the cancelled upload must not be reported as uploaded")
    }

    func testRetryNowSkipsTheBackoffWait() async {
        let script = Script([.retry(reason: "server error 502", after: 30)])
        let events = Events()
        let queue = makeQueue(script, events, policy: fastPolicy())
        await queue.enqueue("waiting")
        await eventually { await events.list.contains(.retrying(reason: "server error 502")) }
        await queue.retryNow()
        await eventually(timeout: 1) { await events.list.contains { if case .uploaded = $0 { true } else { false } } }
    }

    func testDropsItemsThatWaitedTooLong() async {
        let script = Script()
        let events = Events()
        let queue = makeQueue(script, events, policy: fastPolicy())
        await queue.enqueue("stale", now: Date(timeIntervalSinceNow: -7200))
        await eventually { await events.list == [.dropped(reason: "too_old")] }
        let callCount = await script.calls.count
        XCTAssertEqual(callCount, 0)
    }

    func testBackoffGrowsExponentiallyWithJitterAndACap() {
        var policy = UploadQueue.Policy()
        policy.baseDelay = 1
        policy.maxDelay = 60
        XCTAssertEqual(UploadQueue.backoff(attempt: 1, policy: policy, jitter: 1), 1)
        XCTAssertEqual(UploadQueue.backoff(attempt: 2, policy: policy, jitter: 1), 2)
        XCTAssertEqual(UploadQueue.backoff(attempt: 4, policy: policy, jitter: 1), 8)
        XCTAssertEqual(UploadQueue.backoff(attempt: 30, policy: policy, jitter: 1), 60)
        XCTAssertEqual(UploadQueue.backoff(attempt: 4, policy: policy, jitter: 0.5), 4)
        for _ in 0..<100 {
            XCTAssert((2...4).contains(UploadQueue.backoff(attempt: 3, policy: policy)))
        }
    }

    func testClassifiesAPIErrors() {
        XCTAssertEqual(APIError.unauthorized.uploadOutcome, .unauthorized)
        XCTAssertEqual(APIError.rateLimited(retryAfter: 7).uploadOutcome, .retry(reason: "rate limited", after: 7))
        XCTAssertEqual(APIError.rejected(status: 413, code: "content_too_large", message: "").uploadOutcome, .rejected(reason: "content_too_large"))
        XCTAssertEqual(APIError.server(status: 503).uploadOutcome, .retry(reason: "server error 503", after: nil))
        XCTAssertEqual(APIError.network(.notConnectedToInternet).uploadOutcome, .offline)
        XCTAssertEqual(APIError.network(.timedOut).uploadOutcome, .retry(reason: "network error", after: nil))
    }
}

extension Script {
    func setDelay(_ delay: Duration?) { self.delay = delay }
}
