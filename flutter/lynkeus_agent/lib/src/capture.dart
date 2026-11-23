import 'dart:async';

import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

/*
 * The frame a step's capture takes, made the same on a device (real time) and on a host (virtual time).
 *
 * An endless animation (a spinner, a shimmer, a caret blinking) is wherever the time since it started puts it, and
 * that time is never the same on two sides: a device spends real time on every command, a host jumps its clock. So
 * when `idle` answers and such an animation is running, the agent draws one more frame in which every looping
 * ticker is told it is at its own start (elapsed 0: the phase it began at, which is the same phase after any whole
 * number of turns), and a blinking caret is drawn on. Then it draws nothing until the driver's next request other
 * than a capture (`screenshot`, `still`, `screen` and other reads), so the device's screenshot, taken by its OS some
 * time later, and the host's are of that frame. The next frame is at real time again: the animations never stopped
 * counting, they were only drawn once at a chosen moment.
 *
 * What loops is told by where its ticker started: `AnimationController.repeat`, or the text field's caret. A ticker
 * that runs to an end (a fade, a ripple, a fling) is never moved: drawing one at another time would draw a page
 * sliding in at its start, or start its listeners over.
 *
 */

/// The agent's binding: the app's own WidgetsFlutterBinding, with capture frames. [LynkeusAgent.start] makes it
/// unless the app made its binding first.
class LynkeusBinding extends WidgetsFlutterBinding with FrameCapture {}

// What started a ticker that loops, as the VM names a stack's frames: a few frames above Ticker.start.
const _loopsFrom = [
  'AnimationController.repeat ',
  'EditableTextState._startCursorBlink ',
  'EditableTextState._onCursorTick',
];
const _keptCancelled = 64;

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

  bool? _loops;

  bool get loops => _loops ??= _classify();

  bool _classify() {
    final frames = '$origin'.split('\n');
    final scheduled = frames.indexWhere((f) => f.contains('Ticker.scheduleTick '));
    if (scheduled < 0) return false;
    final caller = frames.elementAtOrNull(scheduled + 1) ?? '';
    if (caller.contains('Ticker.muted= ')) {
      // A muted ticker keeps the time it started at.
      final before = previous;
      if (before == null || !before.loops) return false;
      start = before.start;
      return start != null;
    }
    return caller.contains('Ticker.start ') &&
        frames.skip(scheduled + 2).take(4).any((f) => _loopsFrom.any(f.contains));
  }
}

/// Capture frames for a binding (see the top of this file).
mixin FrameCapture on WidgetsBinding {
  final _live = <int, _Chain>{};
  final _cancelled = <FrameCallback, _Chain>{};
  _Chain? _invoking;

  var _captureNext = false;
  var _pinning = false;
  var _holding = false;
  var _skippedBegin = false;
  var _missedFrame = false;
  Timer? _holdLimit;

  /// Whether frames are held on a capture frame.
  bool get holding => _holding;

  /// Whether the next frame would pin something: a ticker that loops, or a caret that blinks.
  bool get wouldPin => _live.values.any((c) => c.loops) || _carets().isNotEmpty;

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
    final pinned = _pinning && chain.loops;
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

  @override
  void handleBeginFrame(Duration? rawTimeStamp) {
    if (_holding) {
      _skippedBegin = _missedFrame = true;
      return;
    }
    _pinning = _captureNext;
    _captureNext = false;
    super.handleBeginFrame(rawTimeStamp);
  }

  @override
  void handleDrawFrame() {
    if (_skippedBegin) {
      _skippedBegin = false;
      return;
    }
    if (_pinning) {
      for (final (caret, color) in _carets()) {
        caret
          ..showCursor.value = true
          ..cursorColor = color;
      }
    }
    super.handleDrawFrame();
    if (_pinning) {
      _pinning = false;
      _holding = true;
    }
  }

  /// Draws the capture frame and holds it, when something on screen would otherwise be caught at a moment: true if
  /// it did. [stillServing] is asked before the hold gives up by itself, after [limit], so that it never lets go in
  /// the middle of a capture.
  Future<bool> capture({Duration limit = const Duration(seconds: 3), bool Function()? stillServing}) async {
    release();
    if (!framesEnabled || !wouldPin) return false;
    _captureNext = true;
    scheduleFrame();
    await endOfFrame.timeout(const Duration(seconds: 1), onTimeout: () {});
    _captureNext = false;
    if (!_holding) return false;
    void expire() {
      _holdLimit = stillServing?.call() ?? false ? Timer(limit, expire) : null;
      if (_holdLimit == null) release();
    }

    _holdLimit = Timer(limit, expire);
    return true;
  }

  /// Draws at real time again.
  void release() {
    _holdLimit?.cancel();
    _holdLimit = null;
    if (!_holding) return;
    _holding = false;
    if (_missedFrame) {
      _missedFrame = false;
      // The binding still counts the frame it asked for as coming: ask the engine for it.
      platformDispatcher.scheduleFrame();
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

    rootElement?.debugVisitOnstageChildren(visit);
    return out;
  }

  /// For tests: as just launched.
  @visibleForTesting
  void debugRelaunch() => release();
}
