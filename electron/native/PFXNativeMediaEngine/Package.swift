// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PFXNativeMediaEngine",
    platforms: [.macOS(.v13)],
    targets: [
        // PFXMAC Sprint 3 — SQLite media database (pure, unit-tested library).
        .target(
            name: "PFXMediaCore",
            path: "Sources/PFXMediaCore",
            linkerSettings: [
                .linkedLibrary("sqlite3"),
            ]
        ),
        .executableTarget(
            name: "PFXNativeMediaEngine",
            dependencies: ["PFXMediaCore"],
            path: "Sources/PFXNativeMediaEngine",
            linkerSettings: [
                .linkedFramework("AVFoundation"),
                .linkedFramework("VideoToolbox"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("Metal"),
                .linkedFramework("Accelerate"),
                .linkedFramework("Foundation"),
                .linkedFramework("Network"),
                .linkedFramework("CoreImage"),
                .linkedLibrary("sqlite3"),
            ]
        ),
        // Plain executable check harness (XCTest is unavailable with Command Line
        // Tools only). Run: swift run MediaStoreCheck
        .executableTarget(
            name: "MediaStoreCheck",
            dependencies: ["PFXMediaCore"],
            path: "Tests/MediaStoreCheck",
            linkerSettings: [
                .linkedLibrary("sqlite3"),
            ]
        ),
    ]
)
