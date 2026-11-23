import UIKit

/// One thing a person can see or touch, read from what the app tells accessibility, with the object that can act on it.
struct Item {
  enum Kind: String { case button, input, text, image, switchControl = "switch", scroll, view }
  var kind: Kind
  var frame: CGRect
  var testId: String?
  var text: String?
  var label: String?
  var value: String?
  var placeholder: String?
  var enabled = true
  var focused = false
  var depth = 0
  var parent: Int?
  /// The accessibility element or the UIKit view behind it.
  weak var object: NSObject?

  func json(_ i: Int) -> [String: Any] {
    var out: [String: Any] = [
      "i": i, "kind": kind.rawValue, "enabled": enabled, "depth": depth,
      "frame": ["x": frame.minX, "y": frame.minY, "w": frame.width, "h": frame.height],
    ]
    if let testId { out["testId"] = testId }
    if let text { out["text"] = text }
    if let label { out["accessibilityLabel"] = label }
    if let value { out["value"] = value }
    if let placeholder { out["placeholder"] = placeholder }
    if focused { out["focused"] = true }
    if let parent { out["parent"] = parent }
    return out
  }
}

/// Reads the key window's view hierarchy and the accessibility elements its views vend (SwiftUI vends its own through
/// its hosting view). Text fields are read from the UIKit view SwiftUI puts behind them, so they can be typed into.
@MainActor enum Snapshot {
  static var window: UIWindow? {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow }
  }

  static func read() -> (items: [Item], size: CGSize) {
    guard let window else { return ([], .zero) }
    var items: [Item] = []
    visit(window, in: window, depth: 0, parent: nil, into: &items)
    return (withoutShadows(items), window.bounds.size)
  }

  /// SwiftUI vends an accessibility element for a TextField beside the UITextField it puts behind it: one thing on screen,
  /// so the plain element is dropped and the field kept (parents are renumbered to match).
  private static func withoutShadows(_ items: [Item]) -> [Item] {
    let inputs = Set(items.filter { $0.kind == .input }.compactMap(\.testId))
    var newIndex: [Int: Int] = [:]
    var kept: [Item] = []
    for (i, item) in items.enumerated() where !(item.kind == .view && item.testId.map(inputs.contains) == true) {
      newIndex[i] = kept.count
      var copy = item
      copy.parent = item.parent.flatMap { newIndex[$0] }
      kept.append(copy)
    }
    return kept
  }

  private static func toWindow(_ rect: CGRect, _ window: UIWindow) -> CGRect {
    window.screen.coordinateSpace.convert(rect, to: window)
  }

  private static func visit(_ view: UIView, in window: UIWindow, depth: Int, parent: Int?, into items: inout [Item]) {
    if view.isHidden || view.alpha < 0.01 { return }
    var mine = parent
    var below = depth
    if let field = view as? UITextField {
      items.append(Item(kind: .input, frame: view.convert(view.bounds, to: window), testId: id(view), label: view.accessibilityLabel,
                        value: field.isSecureTextEntry ? String(repeating: "•", count: (field.text ?? "").count) : (field.text ?? ""),
                        placeholder: field.placeholder, enabled: field.isEnabled, focused: field.isFirstResponder, depth: depth, parent: parent, object: field))
      return
    }
    if let toggle = view as? UISwitch {
      items.append(Item(kind: .switchControl, frame: view.convert(view.bounds, to: window), testId: id(view), text: toggle.isOn ? "true" : "false",
                        label: view.accessibilityLabel, enabled: toggle.isEnabled, depth: depth, parent: parent, object: toggle))
      return
    }
    if view.isAccessibilityElement {
      items.append(element(view, window, depth, parent))
      mine = items.count - 1
      below = depth + 1
    }
    for object in vended(by: view) { collect(object, window, below, mine, &items) }
    for sub in view.subviews { visit(sub, in: window, depth: below, parent: mine, into: &items) }
  }

  private static func vended(by view: UIView) -> [NSObject] {
    if let list = view.accessibilityElements as? [NSObject], !list.isEmpty { return list }
    let count = view.accessibilityElementCount()
    if count != NSNotFound, count > 0 { return (0..<count).compactMap { view.accessibilityElement(at: $0) as? NSObject } }
    return []
  }

  private static func collect(_ object: NSObject, _ window: UIWindow, _ depth: Int, _ parent: Int?, _ items: inout [Item]) {
    var mine = parent
    var below = depth
    if object.isAccessibilityElement {
      items.append(element(object, window, depth, parent))
      mine = items.count - 1
      below = depth + 1
    }
    let count = object.accessibilityElementCount()
    let children = (object.accessibilityElements as? [NSObject]) ?? (count != NSNotFound && count > 0 ? (0..<count).compactMap { object.accessibilityElement(at: $0) as? NSObject } : [])
    for child in children { collect(child, window, below, mine, &items) }
  }

  private static func id(_ object: NSObject) -> String? {
    // SwiftUI's accessibility elements are not UIKit views and do not declare UIAccessibilityIdentification, but vend the property.
    guard object.responds(to: NSSelectorFromString("accessibilityIdentifier")), let value = object.value(forKey: "accessibilityIdentifier") as? String, !value.isEmpty else { return nil }
    return value
  }

  private static func element(_ object: NSObject, _ window: UIWindow, _ depth: Int, _ parent: Int?) -> Item {
    let traits = object.accessibilityTraits
    let frame = (object as? UIView).map { $0.convert($0.bounds, to: window) } ?? toWindow(object.accessibilityFrame, window)
    let label = object.accessibilityLabel
    var kind = Item.Kind.view
    if traits.contains(.button) || traits.contains(.link) { kind = .button }
    else if traits.contains(.image) { kind = .image }
    else if traits.contains(.staticText) || (label != nil && !traits.contains(.button)) { kind = .text }
    if traits.contains(.adjustable) && kind == .view { kind = .scroll }
    return Item(kind: kind, frame: frame, testId: id(object), text: label, label: kind == .button ? label : nil,
                value: object.accessibilityValue, enabled: !traits.contains(.notEnabled), depth: depth, parent: parent, object: object)
  }
}
