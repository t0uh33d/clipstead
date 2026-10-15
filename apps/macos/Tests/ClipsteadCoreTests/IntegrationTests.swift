import XCTest
@testable import ClipsteadCore

/// End-to-end test against a running server (e.g. `npm run dev` in worker/). Skipped unless configured:
///
///     CLIPSTEAD_TEST_SERVER=http://localhost:8787 CLIPSTEAD_TEST_USERNAME=admin \
///     CLIPSTEAD_TEST_PASSWORD='…' swift test --filter IntegrationTests
final class IntegrationTests: XCTestCase {
    /// The browser side of the flow: a cookie session with a same-origin Origin header, as the web app sends.
    private struct Browser {
        let server: URL
        let session = URLSession(configuration: .ephemeral)

        func call(_ method: String, _ path: String, _ body: [String: String]? = nil) async throws -> (Int, [String: Any]) {
            // Not appending(path:): that would percent-encode the "?" of a query string.
            var request = URLRequest(url: URL(string: "\(server.absoluteString)/api/v1/\(path)")!)
            request.httpMethod = method
            request.setValue(server.absoluteString, forHTTPHeaderField: "Origin")
            if let body {
                request.httpBody = try JSONEncoder().encode(body)
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
            let (data, response) = try await session.data(for: request)
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            return ((response as? HTTPURLResponse)?.statusCode ?? 0, json)
        }
    }

    func testPairUploadSearchAndRevokeAgainstARealServer() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let address = env["CLIPSTEAD_TEST_SERVER"], let username = env["CLIPSTEAD_TEST_USERNAME"],
              let password = env["CLIPSTEAD_TEST_PASSWORD"]
        else { throw XCTSkip("Set CLIPSTEAD_TEST_SERVER, CLIPSTEAD_TEST_USERNAME and CLIPSTEAD_TEST_PASSWORD to run.") }
        let server = try ServerURL.parse(address)
        let browser = Browser(server: server)
        let api = APIClient(server: server)

        // 1. Sign in and start pairing in the "browser".
        let (loginStatus, _) = try await browser.call("POST", "auth/login", ["username": username, "password": password])
        XCTAssertEqual(loginStatus, 200)
        let (createStatus, created) = try await browser.call("POST", "pairings")
        XCTAssertEqual(createStatus, 201)
        let pairing = try XCTUnwrap(created["pairing"] as? [String: Any])
        let pairingID = try XCTUnwrap(pairing["id"] as? String)
        let code = try XCTUnwrap(pairing["code"] as? String)

        // 2. The Mac claims the code; nothing is issued before approval.
        let claim = try await api.claimPairing(code: code, deviceName: "XCTest Mac", platform: "macOS (test)", appVersion: "test")
        let pending = try await api.exchangePairing(pollToken: claim.pollToken)
        guard case .pending = pending else { return XCTFail("credential issued before approval") }

        // 3. Approve in the browser; the Mac's next poll receives its credential, exactly once.
        let (approveStatus, _) = try await browser.call("POST", "pairings/\(pairingID)/approve")
        XCTAssertEqual(approveStatus, 200)
        guard case .approved(let credential) = try await api.exchangePairing(pollToken: claim.pollToken) else {
            return XCTFail("expected a credential after approval")
        }
        XCTAssertEqual(credential.username, username)
        do {
            _ = try await api.exchangePairing(pollToken: claim.pollToken)
            XCTFail("a poll token must not be reusable")
        } catch APIError.rejected(let status, _, _) {
            XCTAssertEqual(status, 410)
        }

        // 4. Upload through the real queue, then retry with the same key: one entry.
        let text = "integration test \(UUID().uuidString)"
        let uploaded = expectation(description: "uploaded")
        let queue = UploadQueue(
            uploader: { item in
                do {
                    return .uploaded(try await api.upload(text: item.text, idempotencyKey: item.id, token: credential.token).createdAt)
                } catch let error as APIError {
                    return error.uploadOutcome
                } catch {
                    return .retry(reason: "unexpected", after: nil)
                }
            },
            listener: { event, _ in if case .uploaded = event { uploaded.fulfill() } }
        )
        await queue.enqueue(text)
        await fulfillment(of: [uploaded], timeout: 10)
        let key = UUID().uuidString
        let first = try await api.upload(text: text + " retry", idempotencyKey: key, token: credential.token)
        let second = try await api.upload(text: text + " retry", idempotencyKey: key, token: credential.token)
        XCTAssertEqual(first, second)

        // 4b. Formatting and images round-trip unchanged.
        let rich = try await api.upload(text: "rich \(UUID())", html: "<b>rich</b>", idempotencyKey: UUID().uuidString, token: credential.token)
        let (_, richEntry) = try await browser.call("GET", "clipboard/\(rich.entryID)")
        XCTAssertEqual((richEntry["entry"] as? [String: Any])?["html"] as? String, "<b>rich</b>")
        let png = try XCTUnwrap(Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="))
        let picture = ClipboardImage(data: png, type: "image/png", thumbnail: Data([0xFF, 0xD8, 0xFF, 0xE0, 0, 1]), width: 1, height: 1)
        let uploadedImage = try await api.upload(text: picture.label, image: picture, idempotencyKey: UUID().uuidString, token: credential.token)
        let imageURL = try XCTUnwrap(URL(string: "\(server.absoluteString)/api/v1/clipboard/\(uploadedImage.entryID)/image"))
        let (imageBytes, imageResponse) = try await browser.session.data(from: imageURL)
        XCTAssertEqual(imageBytes, png)
        XCTAssertEqual((imageResponse as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type"), "image/png")

        // 5. The browser finds the entry by search.
        let query = text.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? text
        let (listStatus, list) = try await browser.call("GET", "clipboard?q=\(query)")
        XCTAssertEqual(listStatus, 200)
        let previews = (list["entries"] as? [[String: Any]])?.compactMap { $0["preview"] as? String } ?? []
        XCTAssertEqual(Set(previews), [text, text + " retry"])

        // 6. Revoke in the browser: the very next upload is refused.
        let (revokeStatus, _) = try await browser.call("DELETE", "devices/\(credential.deviceID)")
        XCTAssertEqual(revokeStatus, 204)
        do {
            _ = try await api.upload(text: "after revoke", idempotencyKey: UUID().uuidString, token: credential.token)
            XCTFail("a revoked credential must be refused")
        } catch let error as APIError {
            XCTAssertEqual(error, .unauthorized)
        }
    }
}
