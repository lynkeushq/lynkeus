#!/bin/bash
# usage: native/ios/Sample/build.sh — builds the sample app and the agent for the iOS Simulator without Xcode project
# files: swiftc, an Info.plist and an ad-hoc signature. Leaves out/Sample.app.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/out"; app="$out/Sample.app"
sdk=$(xcrun --sdk iphonesimulator --show-sdk-path)
rm -rf "$out"; mkdir -p "$app"
xcrun swiftc -swift-version 5 -parse-as-library -target arm64-apple-ios16.0-simulator -sdk "$sdk" -O -module-name Sample \
  "$here"/../LynkeusAgent/Sources/LynkeusAgent/*.swift "$here"/Sources/*.swift -o "$app/Sample"
cat > "$app/Info.plist" <<'P'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.lynkeus.nativesample</string>
<key>CFBundleName</key><string>Sample</string>
<key>CFBundleExecutable</key><string>Sample</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>MinimumOSVersion</key><string>16.0</string>
<key>UILaunchScreen</key><dict/>
<key>UIDeviceFamily</key><array><integer>1</integer></array>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
P
codesign --force --sign - "$app"
echo "$app"
