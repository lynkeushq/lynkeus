# Lynkeus for native iOS (spike)

`LynkeusAgent` is a SwiftPM library that lets `lynkeus` drive a native iOS app (SwiftUI, UIKit or both) the way
`lynkeus-agent` drives a React Native one: same protocol (docs/PROTOCOL.md), same cases, same CLI and MCP tools.

```swift
import LynkeusAgent

@main struct MyApp: App {
  init() {
    #if DEBUG
    if let token = ProcessInfo.processInfo.environment["LYNKEUS_TOKEN"] { LynkeusAgent.start(token: token) }
    #endif
  }
  var body: some Scene { WindowGroup { ContentView() } }
}
```

Give a view a test id with `.accessibilityIdentifier("increment")`. Targets by visible text work without it.

What it does: dials the driver (`ws://127.0.0.1:8123`, `LYNKEUS_PORT` or `port:` to change it), proves the project token,
and answers `screen`, `find`, `press`, `type`, `waitFor`, `idle`, `dismissKeyboard` and `batch`. The screen is read from the
key window's views and the accessibility elements they vend; a press is `accessibilityActivate()` (or `sendActions` on a
UIControl); typing is `insertText` into the UITextField behind a SwiftUI `TextField`.

Not yet: scroll and swipe, `within`, routes, requests and trace, native touches, commands. docs/BEYOND-REACT-NATIVE.md has
the design and what comes next.

## Run the sample

```sh
native/ios/Sample/build.sh          # swiftc + Info.plist + ad-hoc signature, no Xcode project: out/Sample.app
xcrun simctl boot <a simulator> && xcrun simctl install <a simulator> native/ios/Sample/out/Sample.app
cd native/ios/Sample
SIMCTL_CHILD_LYNKEUS_TOKEN=any SIMCTL_CHILD_LYNKEUS_PORT=8471 xcrun simctl launch <a simulator> io.lynkeus.nativesample &
LYNKEUS_TOKEN=any lynkeus case run cases/resend-code.md --ports 8471
```
