import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/*
 * Lynkeus FastSim runs the app's own debug kernel in a host process (the engine's embedder, a virtual clock, its
 * own frames), the same kernel a Simulator or an emulator debug build runs. What the agent does differently there
 * lives here and wakes only on FASTSIM_HOST, which only the host sets: on a simulator or a phone none of it runs.
 *
 * The host speaks to the agent on one channel, `lynkeus/fastsim` (JSON method calls):
 *   hello {agentVersion, binding, safeArea}  -> {commands}  what the host serves (clock, screenshot, ...)
 *   call {name, params}                      -> the command's result, forwarded from a driver request
 *   activity {serving, inFlight}             a driver request being served, the app's requests out: the clock runs
 *                                            ahead while the first is above zero and the second is zero
 */

const channelName = 'lynkeus/fastsim';

/// What the FastSim host tells the agent through the environment.
class FastSimHost {
  FastSimHost._(this.env);

  /// Null unless the app runs inside the FastSim host.
  static FastSimHost? detect([Map<String, String>? environment]) {
    final env = environment ?? Platform.environment;
    return (env['FASTSIM_HOST'] ?? '').isEmpty ? null : FastSimHost._(env);
  }

  final Map<String, String> env;
  final channel = const MethodChannel(channelName, JSONMethodCodec());

  /// Whether the binding is the agent's (with the device's safe area), or the app made one first.
  bool ownsBinding = false;

  /// The OS the host plays. The host also makes dart:io's `Platform` say it; this covers a host without that.
  TargetPlatform? get platform => switch (env['FASTSIM_OS']) {
    'ios' => TargetPlatform.iOS,
    'android' => TargetPlatform.android,
    _ => null,
  };

  /// The device's safe area in logical points: top, right, bottom, left.
  List<double>? get safeArea {
    final sides = env['FASTSIM_SAFE_AREA']?.split(',').map((s) => double.tryParse(s.trim())).toList();
    return sides != null && sides.length == 4 && sides.every((s) => s != null) ? sides.cast<double>() : null;
  }

  /// The host starts each app for a driver port of its own; the kernel's compiled-in values are the device's.
  String? get token => env['LYNKEUS_TOKEN'];
  int? get port => int.tryParse(env['LYNKEUS_PORT'] ?? '');
  String? get driverHost => env['LYNKEUS_HOST'];

  /// Makes the agent's binding the app's, if nothing has made one yet: the embedder has no way to give a view its
  /// safe area, so the binding's root view adds it.
  void installBinding() {
    final os = platform;
    if (os != null) debugDefaultTargetPlatformOverride = os;
    if (BindingBase.debugBindingType() != null) {
      debugPrint(
        'lynkeus: FastSim needs LynkeusAgent.start() before WidgetsFlutterBinding.ensureInitialized(): the app made '
        'its binding first, so the safe area and the plugin stand-ins are off.',
      );
      return;
    }
    FastSimBinding(safeArea ?? const [0, 0, 0, 0]);
    ownsBinding = true;
  }

  /// Asks the host what it serves; empty when it does not answer.
  Future<List<String>> hello(String agentVersion) async {
    try {
      final reply = await channel
          .invokeMapMethod<String, Object?>('hello', {
            'agentVersion': agentVersion,
            'binding': ownsBinding ? 'lynkeus' : 'app',
            'safeArea': ownsBinding && safeArea != null,
          })
          .timeout(const Duration(seconds: 5));
      return [...?(reply?['commands'] as List<Object?>?)?.whereType<String>()];
    } on Object catch (error) {
      debugPrint('lynkeus: the FastSim host did not answer hello ($error)');
      return const [];
    }
  }

  /// A driver request for a command the host serves.
  Future<Object?> call(String name, Object? params) =>
      channel.invokeMethod<Object?>('call', {'name': name, 'params': params});

  var _serving = -1;
  var _inFlight = -1;

  /// Tells the host what holds its clock, when it changes.
  void activity({required int serving, required int inFlight}) {
    if (serving == _serving && inFlight == _inFlight) return;
    _serving = serving;
    _inFlight = inFlight;
    unawaited(
      channel.invokeMethod<void>('activity', {'serving': serving, 'inFlight': inFlight}).catchError((Object _) {}),
    );
  }
}

/// The binding the agent creates inside FastSim, before `runApp` would create the plain one: its root view carries
/// the device's safe area, which the engine's embedder cannot set.
class FastSimBinding extends WidgetsFlutterBinding {
  FastSimBinding(this._sides);

  final List<double> _sides;
  SafeAreaView? _view;

  @override
  Widget wrapWithDefaultView(Widget rootWidget) {
    _view ??= SafeAreaView(platformDispatcher.implicitView!, _sides);
    // Without the deprecated render view and pipeline owner, View makes its own for the wrapper; it still draws into
    // the engine's view, since the wrapper's render() is the engine view's.
    return View(view: _view!, child: rootWidget);
  }
}

class _Padding implements ui.ViewPadding {
  const _Padding(this.left, this.top, this.right, this.bottom);

  @override
  final double left;
  @override
  final double top;
  @override
  final double right;
  @override
  final double bottom;
}

/// The engine's view with the device's safe area: everything else is the engine view's own.
class SafeAreaView implements ui.FlutterView {
  SafeAreaView(this._real, List<double> sides)
    : _viewPadding = _Padding(
        sides[3] * _real.devicePixelRatio,
        sides[0] * _real.devicePixelRatio,
        sides[1] * _real.devicePixelRatio,
        sides[2] * _real.devicePixelRatio,
      );

  final ui.FlutterView _real;
  final ui.ViewPadding _viewPadding;

  @override
  ui.ViewPadding get viewPadding => _viewPadding;

  // As dart:ui computes it from the engine's metrics: the safe area less what the keyboard already covers.
  @override
  ui.ViewPadding get padding {
    final insets = _real.viewInsets;
    return _Padding(
      math.max(0, _viewPadding.left - insets.left),
      math.max(0, _viewPadding.top - insets.top),
      math.max(0, _viewPadding.right - insets.right),
      math.max(0, _viewPadding.bottom - insets.bottom),
    );
  }

  @override
  int get viewId => _real.viewId;
  @override
  ui.PlatformDispatcher get platformDispatcher => _real.platformDispatcher;
  @override
  ui.Display get display => _real.display;
  @override
  double get devicePixelRatio => _real.devicePixelRatio;
  @override
  ui.ViewConstraints get physicalConstraints => _real.physicalConstraints;
  @override
  ui.Size get physicalSize => _real.physicalSize;
  @override
  ui.ViewPadding get viewInsets => _real.viewInsets;
  @override
  ui.ViewPadding get systemGestureInsets => _real.systemGestureInsets;
  @override
  ui.GestureSettings get gestureSettings => _real.gestureSettings;
  @override
  List<ui.DisplayFeature> get displayFeatures => _real.displayFeatures;
  @override
  ui.DisplayCornerRadii? get displayCornerRadii => _real.displayCornerRadii;
  @override
  void render(ui.Scene scene, {ui.Size? size}) => _real.render(scene, size: size);
  @override
  void updateSemantics(ui.SemanticsUpdate update) => _real.updateSemantics(update);
}
