// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Clipstead",
    platforms: [.macOS(.v14)],
    targets: [
        // Everything testable without a UI: server URL rules, API client, clipboard filtering, upload queue, Keychain.
        .target(name: "ClipsteadCore"),
        // The menu bar app.
        .executableTarget(name: "Clipstead", dependencies: ["ClipsteadCore"]),
        .testTarget(name: "ClipsteadCoreTests", dependencies: ["ClipsteadCore"]),
    ]
)
