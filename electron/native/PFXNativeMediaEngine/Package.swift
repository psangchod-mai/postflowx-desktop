// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PFXNativeMediaEngine",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "PFXNativeMediaEngine",
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
            ]
        )
    ]
)
