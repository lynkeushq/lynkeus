# lynkeus_agent

The Lynkeus agent for Flutter apps. Started from `main()` in a debug build, it dials the Lynkeus driver (the CLI, the MCP
server, the case runner), proves the project's token with HMAC-SHA256 without sending it, and answers the
[protocol](../../docs/PROTOCOL.md) from the live widget tree. Release builds leave it out.

```dart
void main() {
  LynkeusAgent.start(); // token from --dart-define=LYNKEUS_TOKEN=...
  runApp(const MyApp());
}
```

What it reads, and from where:

- Elements come from the onstage element tree: routes under an opaque one, `Offstage` subtrees and the rows a lazy
  list keeps built past its viewport are left out. Frames are the render objects' bounds in logical points.
- A test id is a `ValueKey<String>` (`Key('...')`) or a `Semantics(identifier: ...)`, given to the element it names.
- Kinds come from the widgets layer and from what controls tell assistive technology (`Semantics(button: true)`, a
  toggle, a text field's value length, a `GestureDetector` with a tap handler), so the SDK's Material and Cupertino and
  the `material_ui` and `cupertino_ui` packages read the same.
- `covered` is Flutter's own hit test at the element's center; `hidden: behind-modal` is everything under the topmost
  modal route's barrier; `inert` is under an `IgnorePointer` or `AbsorbPointer`.
- Requests made through dart:io's `HttpClient` (package:http's `IOClient`, dio's default adapter) are wrapped through
  `HttpOverrides.global`: recorded for `requests` and `trace` with secrets redacted by the same rules as the React
  Native agent, counted in flight for `idle`, and answered, held or lost by the driver's `netmock` rules.
