import Foundation

/// Every failure the API client reports, classified by what the caller should do about it.
public enum APIError: Error, Equatable, Sendable {
    /// The credential is missing, revoked or expired. Re-pairing is required.
    case unauthorized
    /// Too many requests; wait `retryAfter` seconds (if the server said) and try again.
    case rateLimited(retryAfter: TimeInterval?)
    /// The server refused the request (4xx). Retrying the same request will not help.
    case rejected(status: Int, code: String, message: String)
    /// The server failed (5xx). Retrying later may help.
    case server(status: Int)
    /// The server could not be reached.
    case network(URLError.Code)
    case invalidResponse
}

extension APIError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .unauthorized: "This Mac is not paired, or its access was revoked."
        case .rateLimited: "The server is rate limiting requests. Retrying shortly."
        case .rejected(_, _, let message): message
        case .server(let status): "The server had a problem (HTTP \(status))."
        case .network(let code) where code == .timedOut: "The server did not respond in time."
        case .network: "Could not reach the server."
        case .invalidResponse: "The server sent an unexpected response."
        }
    }
}

public struct PairingClaim: Equatable, Sendable {
    public let pollToken: String
    public let expiresAt: Date
    public let pollInterval: TimeInterval
}

public struct DeviceCredential: Equatable, Sendable {
    public let token: String
    public let deviceID: String
    public let deviceName: String
    public let username: String
}

public enum PairingStatus: Equatable, Sendable {
    case pending(pollInterval: TimeInterval)
    case approved(DeviceCredential)
}

public struct DeviceInfo: Equatable, Sendable {
    public let deviceID: String
    public let deviceName: String
    public let username: String
    public let maxContentBytes: Int
}

public struct UploadReceipt: Equatable, Sendable {
    public let entryID: String
    public let createdAt: Date
}

/// Talks to a Clipstead server. Device credentials go in the Authorization header, never in URLs.
public struct APIClient: Sendable {
    public let server: URL
    private let session: URLSession

    public init(server: URL, session: URLSession = APIClient.makeSession()) {
        self.server = server
        self.session = session
    }

    /// No cookies, no response cache, bounded timeouts.
    public static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 60
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }

    public func claimPairing(code: String, deviceName: String, platform: String, appVersion: String) async throws -> PairingClaim {
        struct Body: Decodable { let pollToken: String; let expiresAt: Int64; let pollIntervalMs: Int }
        let body: Body = try await send("POST", "device/pairing/claim", body: [
            "code": code, "device_name": deviceName, "platform": platform, "app_version": appVersion,
        ])
        return PairingClaim(pollToken: body.pollToken, expiresAt: date(body.expiresAt), pollInterval: Double(body.pollIntervalMs) / 1000)
    }

    public func exchangePairing(pollToken: String) async throws -> PairingStatus {
        struct Body: Decodable {
            struct Device: Decodable { let id: String; let name: String }
            struct User: Decodable { let username: String }
            let status: String
            let pollIntervalMs: Int?
            let deviceToken: String?
            let device: Device?
            let user: User?
        }
        let body: Body = try await send("POST", "device/pairing/token", body: ["poll_token": pollToken])
        if body.status == "approved", let token = body.deviceToken, let device = body.device, let user = body.user {
            return .approved(DeviceCredential(token: token, deviceID: device.id, deviceName: device.name, username: user.username))
        }
        return .pending(pollInterval: Double(body.pollIntervalMs ?? 3000) / 1000)
    }

    public func deviceInfo(token: String) async throws -> DeviceInfo {
        struct Body: Decodable {
            struct Device: Decodable { let id: String; let name: String }
            struct User: Decodable { let username: String }
            struct Limits: Decodable { let maxContentBytes: Int }
            let device: Device
            let user: User
            let limits: Limits
        }
        let body: Body = try await send("GET", "device/me", token: token)
        return DeviceInfo(deviceID: body.device.id, deviceName: body.device.name, username: body.user.username, maxContentBytes: body.limits.maxContentBytes)
    }

    /// Revokes this device's own credential on the server.
    public func unpair(token: String) async throws {
        _ = try await perform("DELETE", "device/me", token: token, body: nil)
    }

    /// Uploads text, optionally with its formatted version as HTML, or an image (with `text` as its label). Retrying
    /// with the same `idempotencyKey` never creates a second entry.
    public func upload(
        text: String, html: String? = nil, image: ClipboardImage? = nil, idempotencyKey: String, token: String
    ) async throws -> UploadReceipt {
        struct Body: Decodable {
            struct Entry: Decodable { let id: String; let createdAt: Int64 }
            let entry: Entry
        }
        var fields = ["content": text, "content_type": "text/plain", "idempotency_key": idempotencyKey]
        if let html { fields["html"] = html }
        if let image {
            fields["image"] = image.data.base64EncodedString()
            fields["image_type"] = image.type
            fields["thumbnail"] = image.thumbnail.base64EncodedString()
        }
        let body: Body = try await send("POST", "device/clipboard", token: token, body: fields)
        return UploadReceipt(entryID: body.entry.id, createdAt: date(body.entry.createdAt))
    }

    // MARK: - Transport

    private struct ErrorBody: Decodable {
        struct Detail: Decodable { let code: String; let message: String }
        let error: Detail
    }

    private func date(_ ms: Int64) -> Date { Date(timeIntervalSince1970: Double(ms) / 1000) }

    private func send<T: Decodable>(_ method: String, _ path: String, token: String? = nil, body: [String: String]? = nil) async throws -> T {
        let data = try await perform(method, path, token: token, body: body)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard let value = try? decoder.decode(T.self, from: data) else { throw APIError.invalidResponse }
        return value
    }

    /// Performs the request and maps every non-2xx status to an `APIError`.
    private func perform(_ method: String, _ path: String, token: String?, body: [String: String]?) async throws -> Data {
        var request = URLRequest(url: server.appending(path: "api/v1/\(path)"))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            throw APIError.network(error.code)
        } catch {
            throw APIError.network(.unknown)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }

        switch http.statusCode {
        case 200..<300:
            return data
        case 401:
            throw APIError.unauthorized
        case 429:
            throw APIError.rateLimited(retryAfter: http.value(forHTTPHeaderField: "Retry-After").flatMap(TimeInterval.init))
        case 400..<500:
            let detail = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
            throw APIError.rejected(
                status: http.statusCode,
                code: detail?.code ?? "http_\(http.statusCode)",
                message: detail?.message ?? "The server rejected the request (HTTP \(http.statusCode))."
            )
        default:
            throw APIError.server(status: http.statusCode)
        }
    }
}
