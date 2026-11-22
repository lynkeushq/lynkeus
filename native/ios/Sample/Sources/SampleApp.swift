#if canImport(LynkeusAgent)
import LynkeusAgent
#endif
import SwiftUI

@main struct SampleApp: App {
  init() {
    let env = ProcessInfo.processInfo.environment
    if let token = env["LYNKEUS_TOKEN"] { LynkeusAgent.start(token: token, port: Int(env["LYNKEUS_PORT"] ?? "") ?? 8123, app: ["name": "native-sample"]) }
  }

  var body: some Scene { WindowGroup { ContentView() } }
}

struct ContentView: View {
  @State private var count = 0
  @State private var name = ""
  @State private var left: Int?

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Count: \(count)").font(.title).accessibilityIdentifier("count")
      Button("Add one") { count += 1 }.accessibilityIdentifier("increment")
      TextField("Your name", text: $name).textFieldStyle(.roundedBorder).accessibilityIdentifier("name")
      Button("Send code") { left = 3 }.accessibilityIdentifier("send")
      if let left { Text(left > 0 ? "Resend in \(left)" : "Resend now").accessibilityIdentifier("resend") }
      Button("Locked") {}.disabled(true).accessibilityIdentifier("locked")
      Spacer()
    }
    .padding()
    .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { _ in
      if let current = left, current > 0 { left = current - 1 }
    }
  }
}
