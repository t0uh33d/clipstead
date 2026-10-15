import Foundation

public enum ServerURLError: Error, Equatable, LocalizedError {
    case invalid
    case insecure
    case notAnOrigin

    public var errorDescription: String? {
        switch self {
        case .invalid: "Enter a server address like https://clipstead.example.workers.dev."
        case .insecure: "Use https://. Plain http:// is only allowed for localhost during development."
        case .notAnOrigin: "Enter only the server address, without a path, query or login details."
        }
    }
}

public enum ServerURL {
    /// Validates what the user typed and returns the server's origin (scheme, host and port only).
    /// HTTPS is required; plain HTTP is accepted only for this Mac (local development).
    public static func parse(_ input: String) throws -> URL {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.contains("://") { text = "https://" + text }
        guard var parts = URLComponents(string: text),
              let scheme = parts.scheme?.lowercased(),
              let host = parts.host, !host.isEmpty
        else { throw ServerURLError.invalid }
        guard parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/"
        else { throw ServerURLError.notAnOrigin }
        switch scheme {
        case "https": break
        case "http" where isLocal(host): break
        case "http": throw ServerURLError.insecure
        default: throw ServerURLError.invalid
        }
        parts.scheme = scheme
        parts.host = host.lowercased()
        parts.path = ""
        guard let url = parts.url else { throw ServerURLError.invalid }
        return url
    }

    public static func isLocal(_ host: String) -> Bool {
        ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host.lowercased())
    }
}
