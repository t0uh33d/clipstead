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
        XCTAssertEqual(filter.evaluate(types: ["com.example.custom"], sourceApp: nil, lastUploadedHash: nil) { nil }, .skip(.noText))
        XCTAssertEqual(filter.evaluate(types: types, sourceApp: nil, lastUploadedHash: nil) { " \n\t " }, .skip(.empty))
        // 6 characters, 18 UTF-8 bytes: the limit is in bytes.
        XCTAssertEqual(filter.evaluate(types: types, sourceApp: nil, lastUploadedHash: nil) { "日本語日本語" }, .skip(.tooLarge))
        let hash = ClipboardFilter.hash("same")
        XCTAssertEqual(filter.evaluate(types: types, sourceApp: nil, lastUploadedHash: hash) { "same" }, .skip(.duplicate))
        XCTAssertEqual(filter.evaluate(types: types, sourceApp: "com.apple.Safari", lastUploadedHash: hash) { "different" }, .upload("different"))
    }

    func testDecidesBetweenTextImagesAndFiles() {
        let none: () -> String? = { nil }
        XCTAssertEqual(filter.evaluate(types: ["public.png", "public.tiff"], sourceApp: nil, lastUploadedHash: nil, text: none), .uploadImage)
        // Text wins: spreadsheets and slides add a picture of the selection next to its text.
        XCTAssertEqual(filter.evaluate(types: ["public.png", "public.utf8-plain-text"], sourceApp: nil, lastUploadedHash: nil) { "A1" }, .upload("A1"))
        // Finder copies carry the file name as text and the icon as an image: neither is synced.
        XCTAssertEqual(filter.evaluate(types: ["public.file-url", "public.utf8-plain-text", "public.tiff"], sourceApp: nil, lastUploadedHash: nil) { "report.pdf" }, .skip(.file))
        // Privacy markers and exclusions apply to images too.
        XCTAssertEqual(filter.evaluate(types: ["public.png", "org.nspasteboard.ConcealedType"], sourceApp: nil, lastUploadedHash: nil, text: none), .skip(.concealed))
        XCTAssertEqual(filter.evaluate(types: ["public.png"], sourceApp: "com.1password.1password", lastUploadedHash: nil, text: none), .skip(.excludedApp))
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

final class RichContentTests: XCTestCase {
    private func withPasteboard(_ body: (NSPasteboard) throws -> Void) rethrows {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("clipstead-test-\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        try body(pasteboard)
    }

    func testFormattingComesFromHTMLOrConvertedRTF() throws {
        try withPasteboard { pasteboard in
            pasteboard.declareTypes([.string, .html], owner: nil)
            pasteboard.setString("Bold", forType: .string)
            pasteboard.setString("<b>Bold</b>", forType: .html)
            XCTAssertEqual(pasteboard.formattedHTML, "<b>Bold</b>", "an app's own HTML is used as is")

            pasteboard.clearContents()
            pasteboard.declareTypes([.string, .rtf], owner: nil)
            pasteboard.setString("Bold and italic", forType: .string)
            pasteboard.setData(Data(#"{\rtf1\ansi {\b Bold} and {\i italic}}"#.utf8), forType: .rtf)
            let converted = try XCTUnwrap(pasteboard.formattedHTML)
            XCTAssertTrue(converted.contains("<b>Bold</b>"), converted)
            XCTAssertTrue(converted.contains("<i>italic</i>"), converted)

            pasteboard.clearContents()
            pasteboard.setString("plain", forType: .string)
            XCTAssertNil(pasteboard.formattedHTML)
        }
    }

    /// An image with `width`×`height` pixels of noise (incompressible) or one flat colour.
    private func makeImage(width: Int, height: Int, noise: Bool) throws -> CGImage {
        let context = try XCTUnwrap(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        if noise, let pixels = context.data {
            var generator = SystemRandomNumberGenerator()
            let words = pixels.bindMemory(to: UInt64.self, capacity: width * height / 2)
            for i in 0..<(width * height / 2) { words[i] = generator.next() | 0xFF00_0000_FF00_0000 } // Opaque alpha.
        } else {
            context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
        return try XCTUnwrap(context.makeImage())
    }

    private func png(_ image: CGImage) throws -> Data {
        try XCTUnwrap(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]))
    }

    func testKeepsTheOriginalPNGWhenItFits() throws {
        let image = try makeImage(width: 800, height: 600, noise: false)
        let original = try png(image)
        let fitted = try XCTUnwrap(ClipboardImage.fitting(ClipboardImageSource(image: image, png: original), maxBytes: 1 << 20))
        XCTAssertEqual(fitted.data, original)
        XCTAssertEqual(fitted.type, "image/png")
        XCTAssertEqual(fitted.label, "Image 800 × 600")
        XCTAssertEqual(Array(fitted.thumbnail.prefix(3)), [0xFF, 0xD8, 0xFF], "thumbnails are JPEG")
        let thumb = try XCTUnwrap(NSBitmapImageRep(data: fitted.thumbnail))
        XCTAssertEqual(max(thumb.pixelsWide, thumb.pixelsHigh), ClipboardImage.thumbnailSide)
    }

    func testShrinksImagesThatDoNotFit() throws {
        let image = try makeImage(width: 3000, height: 2000, noise: true)
        let fitted = try XCTUnwrap(ClipboardImage.fitting(ClipboardImageSource(image: image, png: try png(image)), maxBytes: 1 << 20))
        XCTAssertEqual(fitted.type, "image/jpeg")
        XCTAssertLessThanOrEqual(fitted.data.count + fitted.thumbnail.count, 1 << 20)
        XCTAssertEqual(Array(fitted.data.prefix(3)), [0xFF, 0xD8, 0xFF])
        XCTAssertLessThan(fitted.width, 3000)
        XCTAssertEqual(fitted.width * 2, fitted.height * 3, accuracy: 3, "aspect ratio is kept")
        XCTAssertNil(ClipboardImage.fitting(ClipboardImageSource(image: image, png: nil), maxBytes: 4096), "nothing fits")
    }

    func testReadsImagesFromARealPasteboard() throws {
        try withPasteboard { pasteboard in
            let original = try png(try makeImage(width: 64, height: 48, noise: false))
            pasteboard.declareTypes([.png], owner: nil)
            pasteboard.setData(original, forType: .png)
            let source = try XCTUnwrap(pasteboard.imageSource)
            XCTAssertEqual(source.png, original)
            XCTAssertEqual([source.image.width, source.image.height], [64, 48])
        }
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
