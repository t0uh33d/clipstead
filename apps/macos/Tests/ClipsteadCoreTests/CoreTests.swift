import AppKit
import XCTest
@testable import ClipsteadCore

final class ServerURLTests: XCTestCase {
    func testAcceptsHTTPSAndNormalisesToOrigin() throws {
        XCTAssertEqual(try ServerURL.parse("https://clip.example.workers.dev").absoluteString, "https://clip.example.workers.dev")
        XCTAssertEqual(try ServerURL.parse("  HTTPS://Clip.Example.com/  ").absoluteString, "https://clip.example.com")
        XCTAssertEqual(try ServerURL.parse("clip.example.com").absoluteString, "https://clip.example.com")
        XCTAssertEqual(try ServerURL.parse("https://clip.example.com:8443").absoluteString, "https://clip.example.com:8443")
    }

    func testAllowsPlainHTTPOnlyForLocalhost() throws {
        XCTAssertEqual(try ServerURL.parse("http://localhost:8787").absoluteString, "http://localhost:8787")
        XCTAssertEqual(try ServerURL.parse("http://127.0.0.1:8787").absoluteString, "http://127.0.0.1:8787")
        XCTAssertThrowsError(try ServerURL.parse("http://clip.example.com")) { XCTAssertEqual($0 as? ServerURLError, .insecure) }
        XCTAssertThrowsError(try ServerURL.parse("http://192.168.1.10:8787")) { XCTAssertEqual($0 as? ServerURLError, .insecure) }
    }

    func testRejectsAnythingButAnOrigin() {
        for input in ["https://clip.example.com/api", "https://clip.example.com/?x=1", "https://user:pw@clip.example.com", "https://clip.example.com/#frag"] {
            XCTAssertThrowsError(try ServerURL.parse(input), input) { XCTAssertEqual($0 as? ServerURLError, .notAnOrigin, input) }
        }
        for input in ["", "   ", "ftp://clip.example.com", "https://"] {
            XCTAssertThrowsError(try ServerURL.parse(input), input)
        }
    }
}

final class ClipboardFilterTests: XCTestCase {
    let filter = ClipboardFilter(excludedApps: ["com.1password.1password"], maxBytes: 16)

    func testSkipsConcealedContentWithoutReadingIt() {
        var read = false
        let decision = filter.evaluate(types: ["public.utf8-plain-text", "org.nspasteboard.ConcealedType"], sourceApp: nil, lastUploadedHash: nil) {
            read = true
            return "hunter2"
        }
        XCTAssertEqual(decision, .skip(.concealed))
        XCTAssertFalse(read)
    }

    func testSkipsExcludedAppsWithoutReadingContent() {
        var read = false
        let decision = filter.evaluate(types: ["public.utf8-plain-text"], sourceApp: "com.1password.1password", lastUploadedHash: nil) {
            read = true
            return "secret"
        }
        XCTAssertEqual(decision, .skip(.excludedApp))
        XCTAssertFalse(read)
    }

    func testSkipsMissingEmptyOversizedAndRepeatedText() {
        let types: Set<String> = ["public.utf8-plain-text"]
        XCTAssertEqual(filter.evaluate(types: ["public.png"], sourceApp: nil, lastUploadedHash: nil) { nil }, .skip(.noText))
        XCTAssertEqual(filter.evaluate(types: types, sourceApp: nil, lastUploadedHash: nil) { " \n\t " }, .skip(.empty))
        // 6 characters, 18 UTF-8 bytes: the limit is in bytes.
        XCTAssertEqual(filter.evaluate(types: types, sourceApp: nil, lastUploadedHash: nil) { "日本語日本語" }, .skip(.tooLarge))
        let hash = ClipboardFilter.hash("same")
        XCTAssertEqual(filter.evaluate(types: types, sourceApp: nil, lastUploadedHash: hash) { "same" }, .skip(.duplicate))
        XCTAssertEqual(filter.evaluate(types: types, sourceApp: "com.apple.Safari", lastUploadedHash: hash) { "different" }, .upload("different"))
    }

    func testReadsMarkersFromARealPasteboard() {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("clipstead-test-\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        pasteboard.declareTypes([.string, NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")], owner: nil)
        pasteboard.setString("password123", forType: .string)
        let decision = filter.evaluate(types: pasteboard.typeIdentifiers, sourceApp: nil, lastUploadedHash: nil) {
            pasteboard.string(forType: .string)
        }
        XCTAssertEqual(decision, .skip(.concealed))

        pasteboard.clearContents()
        pasteboard.setString("plain", forType: .string)
        XCTAssertEqual(
            filter.evaluate(types: pasteboard.typeIdentifiers, sourceApp: nil, lastUploadedHash: nil) { pasteboard.string(forType: .string) },
            .upload("plain")
        )
    }
}

final class KeychainTests: XCTestCase {
    func testStoresReadsReplacesAndDeletes() throws {
        let keychain = Keychain(service: "Clipstead tests \(UUID().uuidString)")
        let account = "https://clip.example.com"
        do {
            try keychain.save("csd_first", account: account)
        } catch {
            throw XCTSkip("Keychain unavailable in this environment: \(error.localizedDescription)")
        }
        defer { keychain.delete(account: account) }
        XCTAssertEqual(keychain.read(account: account), "csd_first")
        try keychain.save("csd_second", account: account)
        XCTAssertEqual(keychain.read(account: account), "csd_second")
        XCTAssertNil(keychain.read(account: "https://other.example.com"))
        keychain.delete(account: account)
        XCTAssertNil(keychain.read(account: account))
    }
}
