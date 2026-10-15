import XCTest
@testable import ClipsteadCore

/// Intercepts URLSession requests so the client can be tested without a server.
final class StubProtocol: URLProtocol {
    // Tests run serially; the stub is reset in setUp.
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, [String: String], Data))?
    nonisolated(unsafe) static var requests: [(request: URLRequest, body: Data)] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        Self.requests.append((request, Self.readBody(request)))
        do {
            guard let handler = Self.handler, let url = request.url else { throw URLError(.unknown) }
            let (status, headers, data) = try handler(request)
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    private static func readBody(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

final class APIClientTests: XCTestCase {
    var client: APIClient!

    override func setUp() {
        StubProtocol.handler = nil
        StubProtocol.requests = []
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        client = APIClient(server: URL(string: "https://clip.example.com")!, session: URLSession(configuration: config))
    }

    private func respond(_ status: Int, _ json: String, headers: [String: String] = [:]) {
        StubProtocol.handler = { _ in (status, ["Content-Type": "application/json"].merging(headers) { $1 }, Data(json.utf8)) }
    }

    private func error<T>(of operation: () async throws -> T) async -> APIError? {
        do {
            _ = try await operation()
            return nil
        } catch {
            return error as? APIError
        }
    }

    func testUploadSendsTheTokenInAHeaderAndTheTextAsJSON() async throws {
        respond(201, #"{"entry":{"id":"e1","created_at":1700000000000}}"#)
        let receipt = try await client.upload(text: "héllo\n<b>", idempotencyKey: "KEY-1234567890123456", token: "csd_secret")
        XCTAssertEqual(receipt, UploadReceipt(entryID: "e1", createdAt: Date(timeIntervalSince1970: 1_700_000_000)))

        let (request, body) = try XCTUnwrap(StubProtocol.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://clip.example.com/api/v1/device/clipboard")
        XCTAssertFalse(request.url?.absoluteString.contains("csd_secret") ?? true, "tokens never go in URLs")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer csd_secret")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(json, ["content": "héllo\n<b>", "content_type": "text/plain", "idempotency_key": "KEY-1234567890123456"])
    }

    func testUploadsFormattingAndImagesAsJSONFields() async throws {
        respond(201, #"{"entry":{"id":"e2","created_at":1700000000000}}"#)
        _ = try await client.upload(text: "Bold", html: "<b>Bold</b>", idempotencyKey: "KEY-1234567890123456", token: "t")
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: StubProtocol.requests[0].body) as? [String: String])
        XCTAssertEqual(json["html"], "<b>Bold</b>")
        XCTAssertNil(json["image"])

        let image = ClipboardImage(data: Data([0x89, 0x50]), type: "image/png", thumbnail: Data([0xFF, 0xD8]), width: 2, height: 1)
        _ = try await client.upload(text: image.label, image: image, idempotencyKey: "KEY-6543210987654321", token: "t")
        json = try XCTUnwrap(JSONSerialization.jsonObject(with: StubProtocol.requests[1].body) as? [String: String])
        XCTAssertEqual(json["content"], "Image 2 × 1")
        XCTAssertEqual(json["image"], Data([0x89, 0x50]).base64EncodedString())
        XCTAssertEqual(json["image_type"], "image/png")
        XCTAssertEqual(json["thumbnail"], Data([0xFF, 0xD8]).base64EncodedString())
        XCTAssertNil(json["html"])
    }

    func testMapsHTTPFailuresToActionableErrors() async {
        respond(401, #"{"error":{"code":"invalid_device_token","message":"revoked"}}"#)
        let unauthorized = await error { try await self.client.deviceInfo(token: "t") }
        XCTAssertEqual(unauthorized, .unauthorized)

        respond(429, #"{"error":{"code":"rate_limited","message":"slow down"}}"#, headers: ["Retry-After": "7"])
        let limited = await error { try await self.client.deviceInfo(token: "t") }
        XCTAssertEqual(limited, .rateLimited(retryAfter: 7))

        respond(413, #"{"error":{"code":"content_too_large","message":"Too big."}}"#)
        let rejected = await error { try await self.client.upload(text: "x", idempotencyKey: "k", token: "t") }
        XCTAssertEqual(rejected, .rejected(status: 413, code: "content_too_large", message: "Too big."))

        respond(503, "")
        let server = await error { try await self.client.deviceInfo(token: "t") }
        XCTAssertEqual(server, .server(status: 503))

        respond(200, "not json")
        let invalid = await error { try await self.client.deviceInfo(token: "t") }
        XCTAssertEqual(invalid, .invalidResponse)

        StubProtocol.handler = { _ in throw URLError(.notConnectedToInternet) }
        let offline = await error { try await self.client.deviceInfo(token: "t") }
        XCTAssertEqual(offline, .network(.notConnectedToInternet))
    }

    func testPairingClaimAndExchange() async throws {
        respond(200, #"{"poll_token":"csp_abc","expires_at":1700000600000,"poll_interval_ms":3000}"#)
        let claim = try await client.claimPairing(code: "ABCD-EFGH", deviceName: "Mac", platform: "macOS 15.0", appVersion: "0.1.0")
        XCTAssertEqual(claim, PairingClaim(pollToken: "csp_abc", expiresAt: Date(timeIntervalSince1970: 1_700_000_600), pollInterval: 3))
        let claimBody = try XCTUnwrap(JSONSerialization.jsonObject(with: StubProtocol.requests[0].body) as? [String: String])
        XCTAssertEqual(claimBody["code"], "ABCD-EFGH")
        XCTAssertNil(StubProtocol.requests[0].request.value(forHTTPHeaderField: "Authorization"))

        respond(202, #"{"status":"pending","poll_interval_ms":2000}"#)
        let pending = try await client.exchangePairing(pollToken: "csp_abc")
        XCTAssertEqual(pending, .pending(pollInterval: 2))

        respond(200, #"{"status":"approved","device_token":"csd_x","device":{"id":"d1","name":"Mac"},"user":{"username":"alice"}}"#)
        let approved = try await client.exchangePairing(pollToken: "csp_abc")
        XCTAssertEqual(approved, .approved(DeviceCredential(token: "csd_x", deviceID: "d1", deviceName: "Mac", username: "alice")))

        respond(410, #"{"error":{"code":"pairing_unavailable","message":"expired"}}"#)
        let gone = await error { try await self.client.exchangePairing(pollToken: "csp_abc") }
        XCTAssertEqual(gone, .rejected(status: 410, code: "pairing_unavailable", message: "expired"))
    }

    func testUnpairAcceptsAnEmptyResponse() async throws {
        StubProtocol.handler = { _ in (204, [:], Data()) }
        try await client.unpair(token: "csd_x")
        XCTAssertEqual(StubProtocol.requests.first?.request.httpMethod, "DELETE")
    }
}
