import AppKit

/// An image from the clipboard, made to fit the upload limit, with a small thumbnail for history lists.
public struct ClipboardImage: Equatable, Sendable {
    public let data: Data
    /// "image/png" or "image/jpeg".
    public let type: String
    /// JPEG, at most `thumbnailSide` pixels on its longest side.
    public let thumbnail: Data
    public let width: Int
    public let height: Int

    public var label: String { "Image \(width) × \(height)" }

    public static let thumbnailSide = 480
}

/// The pasteboard's image, captured on the main thread so the slow re-encoding can run elsewhere.
/// `@unchecked`: CGImage is immutable and documented as thread-safe.
public struct ClipboardImageSource: @unchecked Sendable {
    public let image: CGImage
    /// The original PNG bytes, when the copying app provided PNG.
    public let png: Data?
}

extension NSPasteboard {
    /// The copied image, if any. Call only after `ClipboardFilter` returned `.uploadImage`.
    public var imageSource: ClipboardImageSource? {
        guard let image = NSImage(pasteboard: self)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return nil
        }
        return ClipboardImageSource(image: image, png: data(forType: .png))
    }
}

extension ClipboardImage {
    /// The original PNG when it fits in `maxBytes` (with the thumbnail); otherwise a re-encoded copy, trying PNG and
    /// then JPEG at falling size and quality. Nil when even the smallest attempt does not fit.
    public static func fitting(_ source: ClipboardImageSource, maxBytes: Int) -> ClipboardImage? {
        let image = source.image
        guard let thumbnail = encode(image, maxSide: thumbnailSide, as: .jpeg, quality: 0.75) else { return nil }
        let budget = maxBytes - thumbnail.data.count - 64 // Room for the label.
        if let png = source.png, png.count <= budget {
            return ClipboardImage(data: png, type: "image/png", thumbnail: thumbnail.data, width: image.width, height: image.height)
        }
        let attempts: [(side: Int, type: NSBitmapImageRep.FileType, quality: Double)] = [
            (4096, .png, 1), (4096, .jpeg, 0.85), (2560, .jpeg, 0.8), (1920, .jpeg, 0.75), (1280, .jpeg, 0.7), (960, .jpeg, 0.6),
        ]
        for attempt in attempts {
            guard let encoded = encode(image, maxSide: attempt.side, as: attempt.type, quality: attempt.quality),
                  encoded.data.count <= budget
            else { continue }
            return ClipboardImage(
                data: encoded.data,
                type: attempt.type == .png ? "image/png" : "image/jpeg",
                thumbnail: thumbnail.data,
                width: encoded.width,
                height: encoded.height
            )
        }
        return nil
    }

    private static func encode(
        _ image: CGImage, maxSide: Int, as type: NSBitmapImageRep.FileType, quality: Double
    ) -> (data: Data, width: Int, height: Int)? {
        let scale = min(1, Double(maxSide) / Double(max(image.width, image.height)))
        let width = max(1, Int((Double(image.width) * scale).rounded()))
        let height = max(1, Int((Double(image.height) * scale).rounded()))
        let opaque = type == .jpeg // JPEG has no transparency: flatten onto white.
        let alpha: CGImageAlphaInfo = opaque ? .noneSkipLast : .premultipliedLast
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                  data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                  bitmapInfo: alpha.rawValue
              )
        else { return nil }
        let rect = CGRect(x: 0, y: 0, width: width, height: height)
        if opaque {
            context.setFillColor(CGColor(gray: 1, alpha: 1))
            context.fill(rect)
        }
        context.interpolationQuality = .high
        context.draw(image, in: rect)
        guard let scaled = context.makeImage(),
              let data = NSBitmapImageRep(cgImage: scaled)
                  .representation(using: type, properties: opaque ? [.compressionFactor: quality] : [:])
        else { return nil }
        return (data, width, height)
    }
}
