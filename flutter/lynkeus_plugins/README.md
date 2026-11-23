# lynkeus_plugins

Lets an app's plugins that have no method-channel default work on a Lynkeus host: the headless host (`flutter test`)
and Lynkeus FastSim. On a simulator, an emulator or a phone it does nothing, and a release build leaves it out.

## Why it exists

A federated plugin gets its platform implementation from the app's plugin registrant, which runs on a device and
not on a host: there is no native side there. Most plugins then fall back to a method channel, which the agent's
stand-ins answer (see lynkeus_headless's README for the list). A few have no such fallback and throw:

| Plugin | Without this package, on a host | With it |
|---|---|---|
| sqflite 2.4+ | `Bad state: databaseFactory not initialized`; cached_network_image shows its error widget, since its cache is a sqflite database | the method-channel factory, answered by the agent with the system's SQLite in a folder of the run |
| shared_preferences 2.3+ `SharedPreferencesAsync`, `SharedPreferencesWithCache` | `Bad state: The SharedPreferencesAsyncPlatform instance must be set.` | the in-memory implementation shared_preferences_platform_interface ships, for the run |

Native views (UiKitView, AndroidView, and so webview_flutter) stay blank on any host: there is nothing to draw them.

## Use

Add it next to `lynkeus_agent` in the app's `dependencies` (a regular dependency: the same code runs on the device
and on the host), and call it on the line after the agent starts:

```dart
LynkeusAgent.start();
LynkeusPlugins.ensureInitialized();
```

It acts only when the agent runs on a host (`LynkeusAgent.standingIn`), and only where nothing is set yet.

## Versions

Flutter 3.47.9 or newer, as `lynkeus_agent`: the versions the packages are tested on (stable, the previous stable
and beta).

It depends on the plugins' platform interfaces, never on the plugins, so an app keeps choosing its plugin versions.
Each range runs from the first release with the API used here to the next major:

- `sqflite_platform_interface >=2.4.0 <3.0.0` (`SqflitePlatform.initWithDatabaseFactoryMethodChannel`)
- `shared_preferences_platform_interface >=2.4.0 <3.0.0` (`SharedPreferencesAsyncPlatform`,
  `InMemorySharedPreferencesAsync`)

The tests run at both ends of the ranges (`flutter pub downgrade`, then the newest), in CI too.

## The next plugin

When a plugin turns out to have no method-channel default: find its platform interface's instance setter; add an
entry in `lib/src/plugins.dart` that sets a channel-based implementation, or an in-memory one the interface package
itself ships (it keeps pace with the interface; implementing an `abstract base class` here would break on its next
minor); add the interface to `pubspec.yaml` with the widest range whose both ends pass the tests; add a test; and, if
it needs a native side, a stand-in in lynkeus_agent's `plugins.dart`.
