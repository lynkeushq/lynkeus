import CryptoKit
import Foundation

/// The app end of the Lynkeus link (docs/PROTOCOL.md): dials the driver, proves it holds the project token with HMAC
/// over both nonces, and serves requests. Dials again every 100 ms while nobody listens, as lynkeus-agent does.
final class Link: NSObject, URLSessionWebSocketDelegate {
  private let url: URL
  private let token: String
  private let hello: () -> [String: Any]
  private let serve: (String, Any?) async throws -> Any
  private var task: URLSessionWebSocketTask?
  private var session: URLSession!
  private var stopped = false

  init(host: String, port: Int, token: String, hello: @escaping () -> [String: Any], serve: @escaping (String, Any?) async throws -> Any) {
    url = URL(string: "ws://\(host):\(port)")!
    self.token = token
    self.hello = hello
    self.serve = serve
    super.init()
    session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
  }

  func start() { connect() }
  func stop() { stopped = true; task?.cancel(with: .goingAway, reason: nil) }

  private func connect() {
    guard !stopped else { return }
    let task = session.webSocketTask(with: url)
    self.task = task
    task.resume()
    var state = Handshake()
    receive(task, &state)
  }

  /// What one connection has learned: the driver's session and nonce, ours, and whether the driver proved itself.
  private struct Handshake { var session = ""; var driverNonce = ""; var appNonce = ""; var verified = false }

  private func receive(_ task: URLSessionWebSocketTask, _ state: inout Handshake) {
    var local = state
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .failure:
        if self.task === task { DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { self.connect() } }
      case .success(let message):
        if case .string(let text) = message { self.handle(text, task, &local) }
        self.receive(task, &local)
      }
    }
  }

  private func proof(_ who: String, _ s: Handshake) -> String {
    let message = "lynkeus/\(who)/\(s.session)/\(s.driverNonce)/\(s.appNonce)"
    let code = HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: SymmetricKey(data: Data(token.utf8)))
    return code.map { String(format: "%02x", $0) }.joined()
  }

  private func send(_ task: URLSessionWebSocketTask, _ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return }
    task.send(.string(text)) { _ in }
  }

  private func handle(_ text: String, _ task: URLSessionWebSocketTask, _ s: inout Handshake) {
    guard let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { return }
    if object["event"] as? String == "auth" {
      s.session = object["session"] as? String ?? ""
      s.driverNonce = object["nonce"] as? String ?? ""
      s.appNonce = (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
      var reply = hello()
      reply["event"] = "hello"
      reply["protocolVersion"] = 2
      reply["nonce"] = s.appNonce
      reply["proof"] = proof("app", s)
      send(task, reply)
      return
    }
    if object["event"] as? String == "verified" {
      if (object["proof"] as? String) == proof("driver", s) { s.verified = true } else { task.cancel(with: .policyViolation, reason: nil) }
      return
    }
    guard let id = object["id"] as? Int, let method = object["method"] as? String else { return }
    guard s.verified else { return send(task, ["id": id, "error": ["message": "unauthenticated", "code": "unauthenticated"]]) }
    let params = object["params"]
    Task {
      do {
        let result = try await self.serve(method, params)
        self.send(task, ["id": id, "result": result])
      } catch {
        self.send(task, ["id": id, "error": ["message": "\(error)"]])
      }
    }
  }
}
