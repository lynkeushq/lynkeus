// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "LynkeusAgent",
  platforms: [.iOS(.v16)],
  products: [.library(name: "LynkeusAgent", targets: ["LynkeusAgent"])],
  targets: [.target(name: "LynkeusAgent", swiftSettings: [.swiftLanguageMode(.v5)])]
)
