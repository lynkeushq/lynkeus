import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'binding.dart';
import 'capture.dart';
import 'fence.dart';
import 'standins.dart';

/*
 * Lynkeus FastSim runs the app's own debug kernel in a host process (the engine's embedder, a virtual clock, its
 * own frames), the same kernel a Simulator or an emulator debug build runs. What the agent does differently there
 * lives here and wakes only on FASTSIM_HOST, which only the host sets: on a simulator or a phone none of it runs.
 *
 * The host speaks to the agent on one channel, `lynkeus/fastsim` (JSON method calls):
 *   hello {agentVersion, binding, safeArea}  -> {commands, platformViews}  what the host serves (clock, screenshot,
 *                                            ...); platformViews "placeholder" when it answers flutter/platform_views
 *                                            itself and draws a placeholder where each native view is
 *   call {name, params}                      -> the command's result, forwarded from a driver request
 *   activity {serving, inFlight}             a driver request being served, the app's requests out: the clock runs
 *                                            ahead while the first is above zero and the second is zero
 */

const channelName = 'lynkeus/fastsim';

/// Where the host hands the agent a plugin's message it does not answer itself, when the app's binding is not the
/// agent's: the channel's name (its UTF-8 length in 4 bytes, little-endian, then the bytes) and the message. The
/// agent's reply is the plugin's answer; empty is "not implemented".
const pluginChannelName = 'lynkeus/fastsim/plugin';

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

  /// With the app's own binding: the host hands the plugins' messages to the stand-ins over [pluginChannelName].
  bool pluginsForwarded = false;

  /// What answers the plugins' channels, when the binding is the agent's; the host answers them otherwise.
  StandIns? standIns;

  /// The OS the host plays. The host also makes dart:io's `Platform` say it; this covers a host without that.
  TargetPlatform? get platform => switch (env['FASTSIM_OS']) {
    'ios' => TargetPlatform.iOS,
    'android' => TargetPlatform.android,
    _ => null,
  };

  /// The device's safe area in logical points: top, right, bottom, left.
  List<double>? get safeArea => _sides(env['FASTSIM_SAFE_AREA']);

  /// What each edge keeps when its system bar is hidden (a cutout, a home indicator); same order.
  List<double>? get safeAreaHidden => _sides(env['FASTSIM_SAFE_AREA_HIDDEN']);

  static List<double>? _sides(String? text) {
    final sides = text?.split(',').map((s) => double.tryParse(s.trim())).toList();
    return sides != null && sides.length == 4 && sides.every((s) => s != null) ? sides.cast<double>() : null;
  }

  /// The host starts each app for a driver port of its own; the kernel's compiled-in values are the device's.
  String? get token => env['LYNKEUS_TOKEN'];
  int? get port => int.tryParse(env['LYNKEUS_PORT'] ?? '');
  String? get driverHost => env['LYNKEUS_HOST'];

  /// Where the app's requests may go: what the project allowed, and the driver's own address.
  Set<String> get networkHosts => {...networkHostsFrom(env), ?driverHost};

  /// Makes the agent's binding the app's, if nothing has made one yet: the embedder has no way to give a view its
  /// safe area, so the binding's root view adds it, and the app's plugins have no native side, so its messenger
  /// hands their channels to the stand-ins.
  void installBinding() {
    final os = platform;
    if (os != null) debugDefaultTargetPlatformOverride = os;
    if (BindingBase.debugBindingType() == null) LynkeusBinding();
    if (WidgetsBinding.instance is! FastSimHooks) {
      debugPrint(
        'lynkeus: the app made its own binding before LynkeusAgent.start(), so on FastSim the safe area is off; '
        'the plugin stand-ins answer through the host. $bindingRemedy',
      );
      final standIns = StandIns(log: debugPrint, trace: env['LYNKEUS_CHANNELS'] == 'trace', hostSaysViews: true);
      ServicesBinding.instance.defaultBinaryMessenger.setMessageHandler(
        pluginChannelName,
        (message) async => answerForwarded(standIns, message),
      );
      this.standIns = standIns;
      pluginsForwarded = true;
      _explainErrors();
      return;
    }
    standIns = FastSimRoot.current?.standIns;
    ownsBinding = standIns != null;
    _explainErrors();
  }

  // Adds the reason to the error an app reports for a plugin no host can stand in for. An app that sets its own
  // handlers later replaces these, and only loses the extra line.
  void _explainErrors() {
    final flutterErrors = FlutterError.onError;
    FlutterError.onError = (details) {
      final why = explainHostError(details.exception);
      if (why != null) debugPrint(why);
      flutterErrors?.call(details);
    };
    final dispatcher = ui.PlatformDispatcher.instance;
    final uncaught = dispatcher.onError;
    dispatcher.onError = (error, stack) {
      final why = explainHostError(error);
      if (why != null) debugPrint(why);
      return uncaught?.call(error, stack) ?? false;
    };
  }

  /// Asks the host what it serves; empty when it does not answer. Fields the agent does not know are ignored.
  Future<List<String>> hello(String agentVersion) async {
    Map<Object?, Object?>? reply;
    try {
      final answer = await channel
          .invokeMethod<Object?>('hello', {
            'agentVersion': agentVersion,
            'binding': ownsBinding ? 'lynkeus' : 'app',
            'safeArea': ownsBinding && safeArea != null,
            if (pluginsForwarded) 'plugins': 'forward',
          })
          .timeout(const Duration(seconds: 5));
      if (answer is Map) reply = answer;
    } on Object catch (error) {
      debugPrint('lynkeus: the FastSim host did not answer hello ($error)');
    }
    // A host from before 2026-11-23 says nothing about native views: the stand-ins keep failing them.
    standIns?.hostAnswersPlatformViews(reply?['platformViews'] == 'placeholder');
    final commands = reply?['commands'];
    return [if (commands is List) ...commands.whereType<String>()];
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

/// A plugin's message the host forwarded (see [pluginChannelName]), answered by [standIns]; null when no stand-in
/// takes it, which the host turns into "not implemented".
@visibleForTesting
Future<ByteData?> answerForwarded(StandIns standIns, ByteData? forwarded) async {
  if (forwarded == null || forwarded.lengthInBytes < 4) return null;
  final length = forwarded.getUint32(0, Endian.little);
  if (forwarded.lengthInBytes < 4 + length) return null;
  final bytes = forwarded.buffer.asUint8List(forwarded.offsetInBytes, forwarded.lengthInBytes);
  final channel = utf8.decode(bytes.sublist(4, 4 + length));
  if (!StandIns.handles(channel, hostViews: true)) return null;
  final message = ByteData.sublistView(Uint8List.fromList(bytes.sublist(4 + length)));
  return standIns.answer(channel, message.lengthInBytes == 0 ? null : message);
}

/// What the agent's binding does inside FastSim, from its constructor on: its root view carries the device's safe
/// area, which the engine's embedder cannot set, and its messenger answers the app's plugins with the stand-ins.
mixin FastSimHooks on WidgetsBinding {
  @override
  BinaryMessenger createBinaryMessenger() {
    final inner = super.createBinaryMessenger();
    return FastSimRoot.current?.messenger(this, inner) ?? inner;
  }

  @override
  Widget wrapWithDefaultView(Widget rootWidget) =>
      FastSimRoot.current?.rootView(this, rootWidget) ?? super.wrapWithDefaultView(rootWidget);
}

/// What [FastSimHooks] keeps: made when the binding is, inside FastSim only.
class FastSimRoot {
  FastSimRoot._(this._sides, this.standIns, {this.hidden});

  /// Inside FastSim, the binding's; null elsewhere.
  static FastSimRoot? get current => _current ??= _detect();
  static FastSimRoot? _current;
  static var _detected = false;

  static FastSimRoot? _detect() {
    if (_detected) return null;
    _detected = true;
    final host = FastSimHost.detect();
    if (host == null) return null;
    return FastSimRoot._(
      host.safeArea ?? const [0, 0, 0, 0],
      StandIns(log: debugPrint, trace: host.env['LYNKEUS_CHANNELS'] == 'trace', hostSaysViews: true),
      hidden: host.safeAreaHidden,
    );
  }

  final List<double> _sides;
  final StandIns standIns;

  /// The safe area with the system bars hidden; null when the host did not say.
  final List<double>? hidden;
  final bars = SystemBars();
  SafeAreaView? _view;
  WidgetsBinding? _binding;

  // Outgoing platform messages reach the host only through this messenger, so the plugins are answered here, and
  // the app hiding or showing the system bars moves the safe area as on a phone.
  BinaryMessenger messenger(WidgetsBinding binding, BinaryMessenger inner) {
    _binding = binding;
    return StandInMessenger(inner, standIns, sent: hidden == null ? null : _watchBars);
  }

  void _watchBars(String channel, ByteData? message) {
    if (channel != SystemChannels.platform.name || message == null) return;
    final MethodCall call;
    try {
      call = SystemChannels.platform.codec.decodeMethodCall(message);
    } on Object {
      return;
    }
    if (!bars.follow(call)) return;
    final view = _view;
    final binding = _binding;
    if (view == null || binding == null) return;
    view.sides = bars.sides(_sides, hidden!);
    scheduleMicrotask(binding.handleMetricsChanged);
  }

  Widget rootView(WidgetsBinding binding, Widget rootWidget) {
    _view ??= SafeAreaView(
      binding.platformDispatcher.implicitView!,
      hidden == null ? _sides : bars.sides(_sides, hidden!),
    );
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
  SafeAreaView(this._real, this.sides);

  final ui.FlutterView _real;

  /// Top, right, bottom, left, in logical points.
  List<double> sides;

  ui.ViewPadding get _viewPadding {
    final dpr = _real.devicePixelRatio;
    return _Padding(sides[3] * dpr, sides[0] * dpr, sides[1] * dpr, sides[2] * dpr);
  }

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

/// Which system bars the app shows, as it told the platform: the status bar is the top edge's, the navigation bar or
/// home indicator the bottom's. Measured on the Pixel 9 emulator: a hidden navigation bar takes the bottom inset to 0
/// while the cutout keeps the top; immersive, immersiveSticky and leanBack hide both, edgeToEdge shows both, and a
/// restore puts back what was last set. On the iPhone 17 Simulator no mode moves the safe area, which the host says
/// by giving the same insets for hidden bars.
class SystemBars {
  var top = true;
  var bottom = true;

  /// Takes a flutter/platform call; true when it changed what is shown.
  bool follow(MethodCall call) {
    final (wasTop, wasBottom) = (top, bottom);
    switch (call.method) {
      case 'SystemChrome.setEnabledSystemUIMode':
        final mode = '${call.arguments}'.split('.').last;
        if (mode == 'edgeToEdge') {
          top = bottom = true;
        } else if (mode == 'immersive' || mode == 'immersiveSticky' || mode == 'leanBack') {
          top = bottom = false;
        }
      case 'SystemChrome.setEnabledSystemUIOverlays':
        final overlays = <String>[
          if (call.arguments is List)
            for (final o in call.arguments as List) '$o'.split('.').last,
        ];
        top = overlays.contains('top');
        bottom = overlays.contains('bottom');
    }
    return top != wasTop || bottom != wasBottom;
  }

  /// The safe area for what is shown: each edge from [shown] while its bar is, else from [hidden].
  List<double> sides(List<double> shown, List<double> hidden) => [
    top ? shown[0] : hidden[0],
    shown[1],
    bottom ? shown[2] : hidden[2],
    shown[3],
  ];
}
