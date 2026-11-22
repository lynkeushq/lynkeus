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

## Lynkeus FastSim

Inside the FastSim host (the app's own debug kernel run by Flutter's embedder, on a clock the host moves) the agent
wakes on `FASTSIM_HOST`, which only the host sets; on a simulator or a phone none of it runs. There it makes the
app's binding, whose root view carries the device's safe area (the embedder cannot set one), asks the host on
`lynkeus/fastsim` which commands it serves (`clock`, `screenshot`, …) and forwards them, and tells the host when a
driver request is being served and how many of the app's requests are out, which is what moves its clock.

For that, `LynkeusAgent.start()` has to come before the app's first `WidgetsFlutterBinding.ensureInitialized()`.
An app that makes its binding first still runs and is driven; it gets no safe area, and says `binding: app` in its
hello.

The app has no native side there either, so the agent's binding answers its plugins' channels with the same
stand-ins the headless host uses (`package:lynkeus_agent/hosts.dart`; the table is in lynkeus_headless's README),
and the same `launched`, `biometrics`, `permissions` and `network` commands drive them. A plugin whose platform
implementation calls native code through FFI instead of a channel (shared_preferences_foundation 2.6 on iOS) is
out of their reach.
