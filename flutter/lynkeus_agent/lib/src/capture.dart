import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

/*
 * The frame a step's capture takes, made the same on a device (real time) and on a host (virtual time): a function of
 * the app's code, the case's steps and the data, never of the wall clock.
 *
 * What ends on its own is waited for, so the frame is of the state it ends in. `idle` is not quiet while
 *  - a one-shot timer the app set is still to fire, when it was set for no longer than the idle's own timeout (a page
 *    that loads after 2 s, a toast that hides after 2 s, a debounce), or set by the app's launch before the driver's
 *    first action (a splash's, however long), until an idle has found the app quiet;
 *  - an animation that runs to an end is running (a fade, a dialog closing, a ripple, a fling).
 * The timers counted are those the app's frames, touches and the agent's other input set, and every timer those set in
 * turn (a zone follows them through futures). Which ones count is decided by how long the app set them for, which is the
 * same on both sides, not by how much time is left, which is not: a device spends real time on every command. A
 * periodic timer never counts, nor a one-shot timer set again from where one just fired (a loop), nor one set for
 * longer than the idle waits (a session's timeout).
 *
 * An endless animation (a spinner, a shimmer, a caret blinking) never ends, so it is drawn at a chosen moment: when
 * `idle` answers and such an animation is running, the agent draws one more frame in which every looping ticker is
 * told it is at its own start (elapsed 0: the phase it began at, which is the same phase after any whole number of
 * turns), and a blinking caret is drawn on. Then it draws nothing until the driver's next request other than a capture
 * (`screenshot`, `still`, `screen` and other reads), so the device's screenshot, taken by its OS some time later, and
 * the host's are of that frame. The next frame is at real time again: the animations never stopped counting, they
 * were only drawn once at a chosen moment.
 *
 * What loops is told by where its ticker started: `AnimationController.repeat`, a controller its own status listener
 * starts again when it ends, or the text field's caret. A ticker that runs to an end is never moved: drawing one at
 * another time would draw a page sliding in at its start, or start its listeners over.
 */

/// What to do when an app has a binding of its own: said wherever the agent finds one it cannot use.
const bindingRemedy =
    'An app with a binding class of its own extends LynkeusBinding (from package:lynkeus_agent) instead of '
    'WidgetsFlutterBinding, and makes it before calling LynkeusAgent.start().';

// What started a ticker that loops, as the VM names a stack's frames: a few frames above Ticker.start.
const _loopsFrom = [
  'AnimationController.repeat ',
  'EditableTextState._startCursorBlink ',
  'EditableTextState._onCursorTick',
];
const _keptCancelled = 64;
final _ink = RegExp(r'\b(InkRipple|InkSplash|InkHighlight|InkSparkle)\b');

enum _Kind {
  /// Never ends by itself: drawn at its start in a capture frame.
  loops,

  /// An AnimationController running to an end: waited for.
  ends,

  /// Neither known (a ticker of the app's own).
  other,
}

/// A frame callback and the ones it schedules again for the next frames: one ticker's run.
class _Chain {
  _Chain(this.callback, this.origin, this.start, this.previous);

  final FrameCallback callback;
  final StackTrace origin;

  /// The frame time the ticker counts from, as Ticker sets it: the current frame's when it starts inside one, else
  /// the time of its first tick.
  Duration? start;

  /// The run this one goes on with, when a ticker that was muted (its route covered) runs again.
  final _Chain? previous;

  _Kind? _kind;

  _Kind get kind => _kind ??= _classify();
  bool get loops => kind == _Kind.loops;

  _Kind _classify() {
    final frames = '$origin'.split('\n');
    final scheduled = frames.indexWhere((f) => f.contains('Ticker.scheduleTick '));
    if (scheduled < 0) return _Kind.other;
    final caller = frames.elementAtOrNull(scheduled + 1) ?? '';
    if (caller.contains('Ticker.muted= ')) {
      // A muted ticker keeps the time it started at.
      final before = previous;
      if (before == null) return _Kind.other;
      start = before.start;
      return start == null ? _Kind.other : before.kind;
    }
    if (!caller.contains('Ticker.start ')) return _Kind.other;
    final above = frames.skip(scheduled + 2);
    if (above.take(4).any((f) => _loopsFrom.any(f.contains))) return _Kind.loops;
    if (!(above.firstOrNull ?? '').contains('AnimationController._startSimulation ')) return _Kind.other;
    // A touch's ink (a ripple, a splash, a highlight) is the finger's own feedback: it ends within any frame's settle,
    // and waiting for it would only slow every press of a run without frames.
    if (above.take(8).any(_ink.hasMatch)) return _Kind.other;
    // Started again by a status listener as its last run ended, in that run's last tick: a loop not built on repeat.
    final listener = above.toList().indexWhere((f) => f.contains('notifyStatusListeners '));
    if (listener >= 0 && above.skip(listener).take(4).any((f) => f.contains('AnimationController._tick '))) {
      return _Kind.loops;
    }
    return _Kind.ends;
  }
}

/// A one-shot timer the app set.
class _AppTimer {
  _AppTimer(this.timer, this.ms, this.setAt, this.origin, {required this.launch});

  final Timer timer;
  final int ms;
  final int setAt;
  final StackTrace origin;

  /// Set before the driver's first action.
  final bool launch;

  int get dueAt => setAt + ms;

  String? _site;

  /// Where in the app it was set: a timer set again from the same place after one fired there is a loop.
  String get site => _site ??= _siteOf(origin);
}

String _siteOf(StackTrace origin) => '$origin'
    .split('\n')
    .where((f) => f.isNotEmpty && !f.contains('dart:async') && !f.contains('lynkeus_agent/src/capture.dart'))
    .take(3)
    .map((f) => f.replaceFirst(RegExp(r'^#\d+\s+'), ''))
    .join('|');

int _now() => clock.now().millisecondsSinceEpoch;

/// The app's capture, once the agent has started: what touch input runs inside.
CaptureFrames? appFrames;

/// What `idle` and the capture need from the app's frames, whatever binding draws them.
abstract interface class CaptureFrames {
  /// Told how long each hold lasted and whether its limit ended it, for the agent's trace.
  abstract void Function(int ms, {required bool expired})? onHoldEnded;

  /// Whether frames are held on a capture frame.
  bool get holding;

  /// Whether the next frame would pin something: a ticker that loops, or a caret that blinks.
  bool get wouldPin;

  /// Whether an animation that runs to an end is running.
  bool get animating;

  /// Whether an image is still being loaded or decoded for its first frame; never known on a foreign binding.
  bool get loadingImages;

  /// Draws the capture frame and holds it, when something on screen would otherwise be caught at a moment: true if
  /// it did. [stillServing] is asked before the hold gives up by itself, after [limit], so that it never lets go in
  /// the middle of a capture.
  Future<bool> capture({Duration limit = const Duration(seconds: 3), bool Function()? stillServing});

  /// Draws at real time again.
  void release();

  /// Runs app code (a frame, a touch, typed text) where the one-shot timers it sets, and those they set in turn, are
  /// known to `idle`.
  T asApp<T>(T Function() run);

  /// Whether a one-shot timer of the app's is still to fire before [beforeMs] (app time): one set for [longestMs] or
  /// less, or one the launch set while it lasts. A timer set again from where one fired since [sinceMs] is a loop.
  bool timerDue({required int longestMs, required int beforeMs, required int sinceMs});

  /// The driver's first action (a press, a deep link): timers set from here on are not the launch's.
  void endLaunchWatch();

  /// The launch is over: called once `idle` has found the app quiet.
  void endLaunch();
}

/// What every binding's capture shares: the app's timers, the hold, the caret. A binding of the agent's own adds its
/// tickers ([FrameCapture]); any other binding gets this alone ([ForeignFrames]).
class CaptureCore implements CaptureFrames {
  CaptureCore(this.binding, {required this.loops, required this.ends});

  final WidgetsBinding binding;

  /// Whether a ticker that loops is running; never known on a foreign binding.
  final bool Function() loops;

  /// Whether an animation that runs to an end is running; never known on a foreign binding.
  final bool Function() ends;

  var _captureNext = false;
  var _holdAfter = false;
  var pinning = false;
  var _holding = false;
  var _skippedBegin = false;
  var _missedFrame = false;
  Timer? _holdLimit;
  int? _heldAt;

  var _launchWatch = true;
  var _launching = true;
  final _timers = <_AppTimer>[];
  final _fired = <String, int>{};
  Zone? _appParent;
  Zone? _appZone;

  @override
  void Function(int ms, {required bool expired})? onHoldEnded;

  @override
  bool get holding => _holding;

  @override
  bool get wouldPin => loops() || _carets().isNotEmpty;

  @override
  bool get animating => ends();

  @override
  bool get loadingImages => false;

  /// A frame's first half, unless frames are held.
  void beginFrame(void Function() run) {
    if (_holding) {
      _skippedBegin = _missedFrame = true;
      return;
    }
    pinning = _captureNext;
    _captureNext = false;
    asApp(run);
  }

  /// A frame's second half, unless its first was held back; a capture frame draws the caret on and starts the hold.
  void drawFrame(void Function() run) {
    if (_skippedBegin) {
      _skippedBegin = false;
      return;
    }
    if (pinning) {
      for (final (caret, color) in _carets()) {
        caret
          ..showCursor.value = true
          ..cursorColor = color;
      }
    }
    asApp(run);
    if (pinning && _holdAfter) {
      _holding = true;
      _heldAt = _now();
    }
    pinning = false;
  }

  @override
  Future<bool> capture({Duration limit = const Duration(seconds: 3), bool Function()? stillServing}) async {
    release();
    if (!binding.framesEnabled) return false;
    final pin = wouldPin;
    // The frame the app last drew can stay off a device's screen until another one comes (the Android emulator showed
    // a list's spinner in a screenshot after the list had loaded), so the capture frame is drawn twice, and the second
    // one is what is held.
    for (var draw = 1; draw <= 2; draw++) {
      _captureNext = pin;
      _holdAfter = pin && draw == 2;
      binding.scheduleFrame();
      await binding.endOfFrame.timeout(const Duration(seconds: 1), onTimeout: () {});
    }
    _captureNext = _holdAfter = false;
    if (!_holding) return false;
    void expire() {
      _holdLimit = stillServing?.call() ?? false ? Timer(limit, expire) : null;
      if (_holdLimit == null) _release(expired: true);
    }

    _holdLimit = Timer(limit, expire);
    return true;
  }

  @override
  void release() => _release(expired: false);

  void _release({required bool expired}) {
    _holdLimit?.cancel();
    _holdLimit = null;
    if (!_holding) return;
    _holding = false;
    final held = _heldAt;
    if (held != null) onHoldEnded?.call(_now() - held, expired: expired);
    _heldAt = null;
    if (_missedFrame) {
      _missedFrame = false;
      // The binding still counts the frame it asked for as coming: ask the engine for it.
      binding.platformDispatcher.scheduleFrame();
    }
  }

  // Focused text fields with an empty selection, whose caret blinks, and the caret's color when it is on.
  List<(RenderEditable, Color)> _carets() {
    final out = <(RenderEditable, Color)>[];
    void visit(Element e) {
      if (e is StatefulElement && e.state is EditableTextState) {
        final state = e.state as EditableTextState;
        final field = state.widget;
        if (field.showCursor && field.focusNode.hasFocus && state.textEditingValue.selection.isCollapsed) {
          out.add((state.renderEditable, field.cursorColor));
        }
      }
      e.debugVisitOnstageChildren(visit);
    }

    binding.rootElement?.debugVisitOnstageChildren(visit);
    return out;
  }

  @override
  T asApp<T>(T Function() run) {
    final parent = Zone.current;
    if (identical(parent, _appZone)) return run();
    if (_appParent != parent) {
      _appParent = parent;
      _appZone = parent.fork(specification: ZoneSpecification(createTimer: _createTimer));
    }
    return _appZone!.run(run);
  }

  Timer _createTimer(Zone self, ZoneDelegate parent, Zone zone, Duration duration, void Function() callback) {
    // One that fires at once is a turn of the event loop, which idle's own looks cover.
    if (duration <= Duration.zero) return parent.createTimer(zone, duration, callback);
    late final _AppTimer entry;
    final timer = parent.createTimer(zone, duration, () {
      if (_fired.length >= 256) _fired.remove(_fired.keys.first);
      _fired
        ..remove(entry.site)
        ..[entry.site] = _now();
      callback();
    });
    // An app no driver ever waits on keeps this list as short as its timers.
    if (_timers.length >= 256) _timers.removeWhere((t) => !t.timer.isActive);
    entry = _AppTimer(timer, duration.inMilliseconds, _now(), StackTrace.current, launch: _launchWatch);
    _timers.add(entry);
    return timer;
  }

  @override
  bool timerDue({required int longestMs, required int beforeMs, required int sinceMs}) {
    _timers.removeWhere((t) => !t.timer.isActive);
    for (final t in _timers) {
      if (t.dueAt > beforeMs || (t.ms > longestMs && !(t.launch && _launching))) continue;
      final fired = _fired[t.site];
      if (fired != null && fired >= sinceMs && t.setAt >= fired) continue;
      return true;
    }
    return false;
  }

  @override
  void endLaunchWatch() => _launchWatch = false;

  @override
  void endLaunch() {
    _launchWatch = false;
    _launching = false;
  }

  /// For tests: as just launched.
  @visibleForTesting
  void debugRelaunch() {
    release();
    _launchWatch = _launching = true;
    _timers.clear();
    _fired.clear();
  }
}

/// Capture frames for a binding, and what `idle` waits for (see the top of this file). Public as part of
/// [LynkeusBinding], whose subclasses an app's own binding can be.
mixin FrameCapture on WidgetsBinding, PaintingBinding implements CaptureFrames {
  final _live = <int, _Chain>{};
  final _cancelled = <FrameCallback, _Chain>{};
  _Chain? _invoking;

  late final _core = CaptureCore(
    this,
    loops: () => _live.values.any((c) => c.loops),
    ends: () => _live.values.any((c) => c.kind == _Kind.ends),
  );

  @override
  void Function(int ms, {required bool expired})? get onHoldEnded => _core.onHoldEnded;
  @override
  set onHoldEnded(void Function(int ms, {required bool expired})? value) => _core.onHoldEnded = value;
  @override
  bool get holding => _core.holding;
  @override
  bool get wouldPin => _core.wouldPin;
  @override
  bool get animating => _core.animating;
  @override
  bool get loadingImages => imageCache is _LoadingImages && (imageCache as _LoadingImages).loading > 0;

  // Flutter's cache keeps an image that failed to load as pending forever: the loads are counted here instead.
  @override
  ImageCache createImageCache() => _LoadingImages();

  @override
  Future<bool> capture({Duration limit = const Duration(seconds: 3), bool Function()? stillServing}) =>
      _core.capture(limit: limit, stillServing: stillServing);
  @override
  void release() => _core.release();
  @override
  T asApp<T>(T Function() run) => _core.asApp(run);
  @override
  bool timerDue({required int longestMs, required int beforeMs, required int sinceMs}) =>
      _core.timerDue(longestMs: longestMs, beforeMs: beforeMs, sinceMs: sinceMs);
  @override
  void endLaunchWatch() => _core.endLaunchWatch();
  @override
  void endLaunch() => _core.endLaunch();

  /// For tests: as just launched.
  @visibleForTesting
  void debugRelaunch() => _core.debugRelaunch();

  @override
  int scheduleFrameCallback(FrameCallback callback, {bool rescheduling = false, bool scheduleNewFrame = true}) {
    final invoking = _invoking;
    final _Chain chain;
    if (rescheduling && invoking != null && invoking.callback == callback) {
      chain = invoking;
    } else {
      final phase = schedulerPhase.index;
      final inFrame = phase > SchedulerPhase.idle.index && phase < SchedulerPhase.postFrameCallbacks.index;
      chain = _Chain(callback, StackTrace.current, inFrame ? currentFrameTimeStamp : null, _cancelled.remove(callback));
    }
    late final int id;
    id = super.scheduleFrameCallback(
      (timeStamp) => _run(id, chain, timeStamp),
      rescheduling: rescheduling,
      scheduleNewFrame: scheduleNewFrame,
    );
    _live[id] = chain;
    return id;
  }

  void _run(int id, _Chain chain, Duration timeStamp) {
    _live.remove(id);
    final pinned = _core.pinning && chain.loops;
    chain.start ??= timeStamp;
    final previous = _invoking;
    _invoking = chain;
    try {
      chain.callback(pinned ? chain.start! : timeStamp);
    } finally {
      _invoking = previous;
    }
  }

  @override
  void cancelFrameCallbackWithId(int id) {
    final chain = _live.remove(id);
    if (chain != null) {
      _cancelled
        ..remove(chain.callback)
        ..[chain.callback] = chain;
      if (_cancelled.length > _keptCancelled) _cancelled.remove(_cancelled.keys.first);
    }
    super.cancelFrameCallbackWithId(id);
  }

  // runApp builds the first page outside a frame, in a timer of its own: a splash's initState runs here.
  @override
  void attachRootWidget(Widget rootWidget) => asApp(() => super.attachRootWidget(rootWidget));

  @override
  void handlePointerEvent(PointerEvent event) => asApp(() => super.handlePointerEvent(event));

  @override
  void handleBeginFrame(Duration? rawTimeStamp) => _core.beginFrame(() => super.handleBeginFrame(rawTimeStamp));

  @override
  void handleDrawFrame() => _core.drawFrame(super.handleDrawFrame);
}

/// The capture on a binding the app made of its own, which the agent cannot mix into: its frames and touches are
/// wrapped where the engine hands them over. The app's timers are known to `idle` and a blinking caret is drawn on
/// in a capture frame; which tickers loop and which run to an end is not known, so spinners are drawn wherever they
/// are and fades are not waited for.
class ForeignFrames {
  ForeignFrames._();

  static CaptureCore install(WidgetsBinding binding) {
    final core = CaptureCore(binding, loops: () => false, ends: () => false);
    // ignore: invalid_use_of_protected_member
    binding.ensureFrameCallbacksRegistered();
    final dispatcher = binding.platformDispatcher;
    final begin = dispatcher.onBeginFrame;
    final draw = dispatcher.onDrawFrame;
    final pointers = dispatcher.onPointerDataPacket;
    if (begin != null) dispatcher.onBeginFrame = (timeStamp) => core.beginFrame(() => begin(timeStamp));
    if (draw != null) dispatcher.onDrawFrame = () => core.drawFrame(draw);
    if (pointers != null) dispatcher.onPointerDataPacket = (packet) => core.asApp(() => pointers(packet));
    return core;
  }
}

/// The image cache, counting the loads that have not given their first frame or failed yet.
class _LoadingImages extends ImageCache {
  var loading = 0;

  @override
  ImageStreamCompleter? putIfAbsent(
    Object key,
    ImageStreamCompleter Function() loader, {
    ImageErrorListener? onError,
  }) => super.putIfAbsent(key, () => _watch(loader()), onError: onError);

  ImageStreamCompleter _watch(ImageStreamCompleter completer) {
    loading++;
    var ended = false;
    late final ImageStreamListener listener;
    void end() {
      if (ended) return;
      ended = true;
      loading--;
      scheduleMicrotask(() => completer.removeListener(listener));
    }

    listener = ImageStreamListener((_, _) => end(), onError: (_, _) => end());
    completer.addListener(listener);
    return completer;
  }
}
