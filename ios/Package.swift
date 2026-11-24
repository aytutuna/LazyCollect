// swift-tools-version: 6.0
import PackageDescription

// CollectKit is the app's side of the Worker's API in plain Foundation, so the Mac runners can test it.
// CollectApp holds the iPhone's views (every file is wrapped in `#if os(iOS)`); project.yml starts it from a thin app target.
// The code stays in the Swift 5 language mode.
let package = Package(
    name: "LazyCollect",
    platforms: [.macOS(.v14), .iOS(.v18)],
    products: [
        .library(name: "CollectKit", targets: ["CollectKit"]),
        .library(name: "CollectApp", targets: ["CollectApp"]),
    ],
    targets: [
        .target(name: "CollectKit", path: "Sources/CollectKit"),
        .target(name: "CollectApp", dependencies: ["CollectKit"], path: "Sources/CollectApp"),
        .testTarget(name: "CollectKitTests", dependencies: ["CollectKit"], path: "Tests/CollectKitTests"),
    ],
    swiftLanguageModes: [.v5]
)
