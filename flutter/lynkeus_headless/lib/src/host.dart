import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_agent/hosts.dart';
import 'package:lynkeus_agent/lynkeus_agent.dart';

import 'fonts.dart';
import 'native.dart';
import 'settings.dart';

/*
 * How time and I/O share one test.
 *
 * The app runs inside a widget test: real layout, real software paint, and a clock that is flutter_test's fake one,
 * so the host decides when time moves. The driver's socket is real I/O, which completes on the real event loop, and
 * a widget test's body only moves when it is pumped. A LiveTestWidgetsFlutterBinding would make the socket easy and
 * lose the clock; a binding of our own would have to redo what the test binding does for text input, assets and
 * views. So the host keeps the test binding and runs a loop of its own in the test body: it yields to the real event
 * loop (`runAsync`) so socket messages and engine work (fonts, PNG encoding) arrive, then pumps one frame of fake
 * time, which runs the app's timers, microtasks and the agent's work for that frame.
 *
 * While the driver is waiting on the app (a request is being served) and no request of the app is out, each turn
 * moves the clock a whole frame with no real waiting: a three second countdown passes in a fraction of a second.
 * Otherwise the clock keeps the wall's pace, so an idle host costs nothing and a real backend's latency stays real.
 */

const _frame = Duration(microseconds: 16667);

/// Work that has to run on the real event loop (the engine's answers), asked for from inside fake time.
class _Real {
  _Real(this.job);
  final Future<Object?> Function() job;
  final done = Completer<Object?>();
}

class _Host {
  _Host(this.tester, this.settings, this.name, this.configure, this.registerPlugins);

  final WidgetTester tester;
  final HostSettings settings;
  final String name;
  final void Function(HostConfig host)? configure;
  final void Function(String platform)? registerPlugins;

  final _real = <_Real>[];
  final _advances = <(Duration, Completer<void>)>[];
  final _settles = <Completer<Map<String, Object?>>>[];
  var _exit = false;
  var _offset = Duration.zero;
  late final Duration _launchOffset;
  late final Clock _fake;

  Future<T> real<T>(Future<T> Function() job) {
    final work = _Real(() async => await job());
    _real.add(work);
    return work.done.future.then((value) => value as T);
  }

  DateTime now() => _fake.now().add(_offset);

  Future<void> run(FutureOr<void> Function() appMain) async {
    final view = tester.view;
    view.devicePixelRatio = settings.devicePixelRatio;
    view.physicalSize = settings.size * settings.devicePixelRatio;
    final ios = settings.platform == TargetPlatform.iOS;
    final insets = FakeViewPadding(
      top: (ios ? 62 : 24) * settings.devicePixelRatio,
      bottom: (ios ? 34 : 0) * settings.devicePixelRatio,
    );
    view.padding = insets;
    view.viewPadding = insets;
    debugDefaultTargetPlatformOverride = settings.platform;
    final locale = settings.locale;
    if (locale != null) {
      tester.platformDispatcher.localesTestValue = [locale];
      tester.platformDispatcher.localeTestValue = locale;
    }
    HttpOverrides.global = FencedHttpOverrides(settings.networkHosts);
    final messenger = tester.binding.defaultBinaryMessenger;
    final standIns = StandIns(log: _log, trace: Platform.environment['LYNKEUS_CHANNELS'] == 'trace');
    messenger.allMessagesHandler = (channel, mock, message) {
      // flutter_test's own (text input, the system channels it mocks) and anything a test set keep answering.
      if (mock != null) return mock(message);
      if (!StandIns.handles(channel)) return messenger.delegate.send(channel, message);
      return standIns.answer(channel, message);
    };
    final plugins = PluginState(Directory.systemTemp.createTempSync('lynkeus-host-'));
    installPlugins(
      standIns,
      plugins,
      LynkeusAgent.register,
      (channel, message) => messenger.handlePlatformMessage(channel, message, null),
      settings.platformName,
    );
    registerPlugins?.call(settings.platformName);
    configure?.call(HostConfig(standIns, plugins));
    final fonts = await tester.runAsync(() => loadFonts(settings.fontsDir)) ?? const [];
    _log('fonts: ${fonts.isEmpty ? 'none loaded (text draws as boxes)' : fonts.join(', ')}');
    final libraries = loadNativeLibraries(Directory.current);
    if (libraries.isNotEmpty) _log('native libraries: ${libraries.join(', ')}');

    _fake = clock;
    _launchOffset = settings.epoch == null ? Duration.zero : settings.epoch!.difference(_fake.now());
    _offset = _launchOffset;
    _log(
      'launch: ${settings.platformName} ${settings.size.width.round()}x${settings.size.height.round()}@${settings.devicePixelRatio}, '
      'locale ${settings.locale?.toLanguageTag() ?? 'default'}, clock ${now().toUtc().toIso8601String()}, '
      'time zone ${DateTime.now().timeZoneName}, network ${settings.networkHosts.join(' ')}',
    );
    _register();
    // An error in the app is the app's, as a red screen is on a device: the host says so and goes on serving, where a
    // widget test would fail at its end.
    final testErrors = FlutterError.onError;
    FlutterError.onError = (details) {
      _log('app error: ${details.exceptionAsString().split('\n').first}');
      final why = explainHostError(details.exception);
      if (why != null) _log(why);
    };
    LynkeusAgent.hostedBy(
      token: settings.token,
      host: settings.driverHost,
      port: settings.port,
      app: {'name': name, 'runtime': 'flutter-headless'},
    );
    // The app's clock (package:clock) answers the launch epoch and what `clock --now` sets; DateTime.now() is the
    // wall's, as in any widget test.
    withClock(Clock(now), () => appMain());
    await tester.pump();
    _log('hosting; waiting for a driver on ${settings.driverHost}:${settings.port} (call the exit command to stop)');
    await _loop();
    FlutterError.onError = testErrors;
    LynkeusAgent.stop();
    // The app's timers go with its tree, so the test ends cleanly rather than on a pending timer.
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(minutes: 1));
    debugDefaultTargetPlatformOverride = null;
    view.reset();
    tester.platformDispatcher.clearAllTestValues();
  }

  Future<void> _loop() async {
    final wall = Stopwatch()..start();
    var last = wall.elapsed;
    while (!_exit) {
      final fast = LynkeusAgent.serving > 0 && LynkeusAgent.requestsInFlight == 0;
      await tester.runAsync(() async {
        while (_real.isNotEmpty) {
          final work = _real.removeAt(0);
          try {
            work.done.complete(await work.job());
          } catch (error, stack) {
            work.done.completeError(error, stack);
          }
        }
        final wait = fast ? Duration.zero : _frame - (wall.elapsed - last);
        await Future<void>.delayed(wait.isNegative ? Duration.zero : wait);
      });
      final elapsed = wall.elapsed - last;
      last = wall.elapsed;
      await tester.pump(fast ? _frame : (elapsed > const Duration(milliseconds: 100) ? _frame * 6 : elapsed));
      while (_advances.isNotEmpty) {
        final (span, done) = _advances.removeAt(0);
        var left = span;
        while (left > Duration.zero) {
          final step = left < _frame ? left : _frame;
          await tester.pump(step);
          left -= step;
        }
        done.complete();
      }
      while (_settles.isNotEmpty) {
        final done = _settles.removeAt(0);
        var turns = 0;
        do {
          await tester.pump(Duration.zero);
          turns++;
        } while (tester.binding.hasScheduledFrame && turns < 100);
        done.complete({'settled': !tester.binding.hasScheduledFrame, 'turns': turns});
      }
    }
  }

  void _register() {
    LynkeusAgent.register('clock', (params) async {
      final p = params is Map ? params : const {};
      if (p['reset'] == true) _offset = _launchOffset;
      final to = p['now'];
      if (to is String) {
        final target = DateTime.tryParse(to);
        if (target == null) throw ArgumentError('clock: cannot parse "$to"');
        _offset = target.difference(_fake.now());
      }
      final advance = p['advanceMs'];
      var moved = 0;
      if (advance is num && advance > 0) {
        final done = Completer<void>();
        _advances.add((Duration(microseconds: (advance * 1000).round()), done));
        await done.future;
        moved = advance.round();
      }
      final answer = <String, Object?>{
        'now': now().toUtc().toIso8601String(),
        'offsetMs': _offset.inMilliseconds,
        'advancedMs': moved,
        'nextDueMs': null,
        'inFlight': LynkeusAgent.requestsInFlight,
      };
      if (p['settle'] == true) {
        final done = Completer<Map<String, Object?>>();
        _settles.add(done);
        answer.addAll(await done.future);
      }
      return answer;
    });
    LynkeusAgent.register('screenshot', (params) async {
      final path = params is Map ? params['path'] : null;
      if (path is! String || path.isEmpty) throw ArgumentError('screenshot needs { path }');
      final renderView = tester.binding.renderViews.first;
      final layer = renderView.debugLayer! as OffsetLayer;
      final image = layer.toImageSync(renderView.paintBounds);
      final bytes = await real(() => image.toByteData(format: ui.ImageByteFormat.png));
      File(path).writeAsBytesSync(bytes!.buffer.asUint8List());
      final size = {'w': image.width, 'h': image.height};
      image.dispose();
      return {'path': path, ...size};
    });
    LynkeusAgent.register('appstate', (params) {
      final state = params is Map ? '${params['state'] ?? 'active'}' : 'active';
      final target = switch (state) {
        'active' => 0,
        'inactive' => 1,
        'background' => 3,
        _ => throw ArgumentError('appstate: "$state" is not active, background or inactive'),
      };
      // The OS goes through every state between two (a resumed app is inactive, then hidden, then paused), and
      // Flutter's lifecycle listeners assert that it does.
      const order = [
        ui.AppLifecycleState.resumed,
        ui.AppLifecycleState.inactive,
        ui.AppLifecycleState.hidden,
        ui.AppLifecycleState.paused,
      ];
      var at = order.indexOf(tester.binding.lifecycleState ?? ui.AppLifecycleState.resumed);
      if (at < 0) at = 0;
      while (at != target) {
        at += at < target ? 1 : -1;
        tester.binding.handleAppLifecycleStateChanged(order[at]);
      }
      return {'state': state};
    });
    LynkeusAgent.register('deeplink', (params) async {
      final url = params is Map ? params['url'] : null;
      if (url is! String || url.isEmpty) throw ArgumentError('deeplink needs { url }');
      await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
        SystemChannels.navigation.name,
        SystemChannels.navigation.codec.encodeMethodCall(
          MethodCall('pushRouteInformation', {'location': url, 'state': null}),
        ),
        (_) {},
      );
      return {'opened': url};
    });
    // The Dart VM gives a running program no heap figures of its own; the process's resident size is what there is,
    // and with no heap limit to compare it to, a runner's restart by heap percentage does not apply.
    LynkeusAgent.register(
      'memory',
      (_) => {'rssMb': ProcessInfo.currentRss ~/ 1048576, 'maxRssMb': ProcessInfo.maxRss ~/ 1048576},
    );
    LynkeusAgent.register('exit', (_) {
      _exit = true;
      return true;
    });
  }
}

/// What a project's `configureHost` gets: the channel stand-ins to add its own to, and the common plugins' state.
class HostConfig {
  HostConfig(this.standIns, this.plugins);
  final StandIns standIns;
  final PluginState plugins;
}

void _log(String line) => stdout.writeln('lynkeus host: $line');

/// Hosts the app for Lynkeus from a test file that `lynkeus headless start` writes: runs the app's [appMain] inside
/// `flutter test`, with no simulator, and serves a driver until the exit command or a signal.
/// [settings] replaces what the environment says (a test of the host itself).
/// [configure] adds the project's own stand-ins (`test/lynkeus_host.dart`'s `configureHost`, which the CLI imports).
/// [registerPlugins] sets, for the platform the host plays (`ios`, `android`), the implementation of a plugin that has
/// no method-channel default but whose platform class speaks one (the CLI writes it for the plugins it knows).
void hostApp(
  FutureOr<void> Function() appMain, {
  required String name,
  HostSettings Function()? settings,
  void Function(HostConfig host)? configure,
  void Function(String platform)? registerPlugins,
}) {
  testWidgets('hosts the app for Lynkeus', (tester) async {
    final given = settings?.call() ?? HostSettings.fromEnvironment();
    if (given.token.isEmpty) throw StateError('lynkeus headless needs LYNKEUS_TOKEN');
    // An error the app does not catch (an async callback that throws) would reach the test's zone, which ends the test:
    // the host's own zone logs it and goes on serving, as the app goes on running on a device.
    final done = Completer<void>();
    runZonedGuarded(
      () => _Host(
        tester,
        given,
        name,
        configure,
        registerPlugins,
      ).run(appMain).then(done.complete, onError: done.completeError),
      (error, stack) {
        _log('app error: ${'$error'.split('\n').first}');
        final why = explainHostError(error);
        if (why != null) _log(why);
      },
    );
    await done.future;
  }, timeout: Timeout.none);
}
