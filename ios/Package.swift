// swift-tools-version: 6.0
import PackageDescription

// CollectKit is the app's side of the Worker's API in plain Foundation, so the Mac runners can test it.
// CollectScan is the scanner's page pipeline (finding the page, perspective, filters, the PDF) in plain Foundation and
// CoreGraphics, copied from Lazy Send's LazySendScan; CollectScanModel runs its corner model (DocAligner's FastViT-T8) on
// ONNX Runtime (MIT), kept in Vendor/onnxruntime. CollectApp holds the iPhone's views (every file is wrapped in `#if os(iOS)`);
// project.yml starts it from a thin app target. The code stays in the Swift 5 language mode.
let package = Package(
    name: "LazyCollect",
    platforms: [.macOS(.v14), .iOS(.v18)],
    products: [
        .library(name: "CollectKit", targets: ["CollectKit"]),
        .library(name: "CollectApp", targets: ["CollectApp"]),
    ],
    dependencies: [
        .package(path: "Vendor/onnxruntime"),
    ],
    targets: [
        .target(name: "CollectKit", path: "Sources/CollectKit"),
        .target(name: "CollectScan", path: "Sources/CollectScan"),
        .target(
            name: "CollectScanModel",
            dependencies: ["CollectScan", .product(name: "onnxruntime", package: "onnxruntime")],
            path: "Sources/CollectScanModel",
            // The model (scripts/fetch_docaligner.sh); the folder holds only the licences until it is fetched.
            resources: [.copy("Models")]
        ),
        .target(name: "CollectApp", dependencies: ["CollectKit", "CollectScan", "CollectScanModel"], path: "Sources/CollectApp"),
        .testTarget(name: "CollectKitTests", dependencies: ["CollectKit"], path: "Tests/CollectKitTests"),
        .testTarget(name: "CollectScanTests", dependencies: ["CollectScan"], path: "Tests/CollectScanTests"),
        // The corner model on the page photos in Tests/CollectScanModelTests/Fixtures/Pages; skipped where it was not fetched.
        .testTarget(
            name: "CollectScanModelTests",
            dependencies: ["CollectScan", "CollectScanModel"],
            path: "Tests/CollectScanModelTests",
            exclude: ["Fixtures"]
        ),
    ],
    swiftLanguageModes: [.v5]
)
