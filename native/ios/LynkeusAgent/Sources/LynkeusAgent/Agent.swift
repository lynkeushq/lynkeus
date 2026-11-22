import UIKit

struct AgentError: Error, CustomStringConvertible {
  let description: String
  init(_ text: String) { description = text }
}

/// The Lynkeus protocol (docs/PROTOCOL.md) answered from a native iOS app: what the screen shows is read from the view
/// hierarchy and accessibility, a press activates the accessibility element, and typing goes into the UIKit field behind a
/// SwiftUI TextField. No runtime of any framework is involved, so the same agent serves SwiftUI, UIKit and mixed apps.
public enum LynkeusAgent {
  nonisolated(unsafe) private static var link: Link?

  /// Starts dialing the driver. Call once, early (an App's init). `token` is the project's: `lynkeus init` writes it.
  public static func start(token: String, host: String = "127.0.0.1", port: Int = 8123, app: [String: Any] = [:]) {
    guard link == nil, !token.isEmpty else { return }
    let hello: () -> [String: Any] = {
      var out: [String: Any] = ["agentVersion": "0.7.5", "platform": "ios", "native": false, "commands": [String](), "runtime": "swift"]
      if !app.isEmpty { out["app"] = app }
      return out
    }
    link = Link(host: host, port: port, token: token, hello: hello) { method, params in
      return try await Methods.shared.call(method, params as? [String: Any] ?? [:])
    }
    link?.start()
  }
}

@MainActor final class Methods {
  static let shared = Methods()
  private var items: [Item] = []
  private var size = CGSize.zero
  private var commit = 0
  private var digest = ""

  private func refresh() {
    let read = Snapshot.read()
    items = read.items
    size = read.size
    let next = items.map { "\($0.kind.rawValue)|\($0.testId ?? "")|\($0.text ?? "")|\($0.value ?? "")|\($0.frame)|\($0.enabled)" }.joined(separator: "\n")
    if next != digest { digest = next; commit += 1 }
  }

  func call(_ method: String, _ params: [String: Any]) async throws -> Any {
    switch method {
    case "ping": return ["pong": true, "native": false, "commands": [String]()]
    case "screen": refresh(); return screen()
    case "find": refresh(); return pick(params).map { $0.1.json($0.0) } ?? NSNull()
    case "press": return try await press(params)
    case "type": return try await type(params)
    case "waitFor": return try await waitFor(params)
    case "idle": return try await idle(params)
    case "dismissKeyboard": Snapshot.window?.endEditing(true); return true
    case "batch":
      var results: [Any] = []
      for call in params["calls"] as? [[String: Any]] ?? [] { results.append(try await self.call(call["method"] as? String ?? "", call["params"] as? [String: Any] ?? [:])) }
      return ["results": results]
    default: throw AgentError("Unknown method \(method)")
    }
  }

  private func screen() -> [String: Any] {
    ["path": [String](), "elements": items.enumerated().map { $1.json($0) }, "commit": commit, "busy": false,
     "window": ["w": size.width, "h": size.height], "costMs": 0]
  }

  // MARK: targets

  private func matches(_ item: Item, _ target: [String: Any]) -> Bool {
    if let testId = target["testId"] as? String { return item.testId == testId }
    guard let text = target["text"] as? String else { return false }
    return [item.text, item.label].contains { $0?.trimmingCharacters(in: .whitespaces) == text }
  }

  private func pick(_ target: [String: Any]) -> (Int, Item)? {
    if let i = target["i"] as? Int { return items.indices.contains(i) ? (i, items[i]) : nil }
    if let x = target["x"] as? Double, let y = target["y"] as? Double {
      return Array(items.enumerated()).last { $1.frame.contains(CGPoint(x: x, y: y)) }.map { ($0.offset, $0.element) }
    }
    var found = items.enumerated().filter { matches($1, target) }
    if found.isEmpty, let text = target["text"] as? String {
      found = items.enumerated().filter { ($1.kind == .button || $1.kind == .input) && ($1.text?.contains(text) ?? false) }
    }
    if let nth = target["nth"] as? Int { return found.indices.contains(nth) ? (found[nth].offset, found[nth].element) : nil }
    return found.last.map { ($0.offset, $0.element) }
  }

  private func need(_ target: [String: Any]) throws -> (Int, Item) {
    refresh()
    guard let hit = pick(target) else {
      let described = (try? JSONSerialization.data(withJSONObject: target)).flatMap { String(data: $0, encoding: .utf8) } ?? "\(target)"
      throw AgentError("No element matches \(described)")
    }
    return hit
  }

  // MARK: actions

  private func press(_ params: [String: Any]) async throws -> Any {
    let (i, item) = try need(params)
    guard item.enabled else { throw AgentError("\(params) is disabled: a press does nothing") }
    guard let object = item.object else { throw AgentError("the element is gone") }
    var done = false
    if let control = object as? UIControl { control.sendActions(for: .touchUpInside); done = true }
    else { done = object.accessibilityActivate() }
    guard done else { throw AgentError("the element did not take the press (its accessibility activation answered false)") }
    try await Task.sleep(nanoseconds: 100_000_000)
    return ["x": item.frame.midX, "y": item.frame.midY, "element": item.json(i), "mode": "js"]
  }

  private func type(_ params: [String: Any]) async throws -> Any {
    let text = params["text"] as? String ?? ""
    refresh()
    let target = params["target"] as? [String: Any]
    let hit = target.flatMap { pick($0) } ?? items.enumerated().first { $1.focused }.map { ($0.offset, $0.element) }
    guard let (i, item) = hit else { throw AgentError(target == nil ? "No input is focused: pass a target" : "No element matches \(target!)") }
    guard let field = item.object as? UITextField else { throw AgentError("the element is not a text field") }
    field.becomeFirstResponder()
    if params["clear"] as? Bool == true { field.selectAll(nil); field.deleteBackward() }
    field.insertText(text)
    if params["submit"] as? Bool == true { field.insertText("\n") }
    try await Task.sleep(nanoseconds: 100_000_000)
    refresh()
    return ["typed": text, "element": items.indices.contains(i) ? items[i].json(i) : item.json(i)]
  }

  private func waitFor(_ params: [String: Any]) async throws -> Any {
    let budget = Double(params["timeoutMs"] as? Int ?? 5000) / 1000
    let targets = [params["target"] as? [String: Any]].compactMap { $0 } + (params["anyOf"] as? [[String: Any]] ?? [])
    let gone = params["gone"] as? Bool == true
    let started = Date()
    while true {
      refresh()
      for target in targets {
        let present = pick(target).map { params["enabled"] == nil || $0.1.enabled == (params["enabled"] as? Bool) } ?? false
        if gone ? !present : present { return ["matched": target, "waitedMs": Int(Date().timeIntervalSince(started) * 1000)] }
      }
      if Date().timeIntervalSince(started) >= budget { throw AgentError("Timed out after \(Int(budget * 1000)) ms waiting for \(targets.first ?? [:])") }
      try await Task.sleep(nanoseconds: 50_000_000)
    }
  }

  private func idle(_ params: [String: Any]) async throws -> Any {
    let quiet = Double(params["quietMs"] as? Int ?? 300) / 1000
    let budget = Double(params["timeoutMs"] as? Int ?? 5000) / 1000
    let started = Date()
    var lastChange = Date()
    refresh()
    var seen = commit
    while true {
      try await Task.sleep(nanoseconds: 50_000_000)
      refresh()
      if commit != seen { seen = commit; lastChange = Date() }
      if Date().timeIntervalSince(lastChange) >= quiet { return ["commit": commit, "idle": true] }
      if Date().timeIntervalSince(started) >= budget { return ["commit": commit, "idle": false] }
    }
  }
}
