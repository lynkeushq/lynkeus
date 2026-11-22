import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'link.dart';
import 'snapshot.dart' show viewId;

/*
 * A finger and a keyboard, from inside the app. Pointer events go into GestureBinding.handlePointerEvent, the call the
 * engine's own touches end in, so they are hit tested and fought over by gesture recognizers like any touch. Text goes
 * in through TextInput, the handler the engine's `flutter/textinput` messages reach, so formatters and onChanged run as
 * they do for a keyboard.
 */

// Far from the engine's own pointer and device ids, so a real touch during a run is not mistaken for ours.
var _nextPointer = 1 << 20;
const _device = 1 << 20;
// From package:clock, so a widget test's fake time moves the gesture's timestamps as it moves its timers.
final _clock = clock.stopwatch()..start();

Duration _now() => Duration(microseconds: _clock.elapsedMicroseconds);

void _dispatch(PointerEvent event) => GestureBinding.instance.handlePointerEvent(event);

Future<void> _sleep(int ms) => Future<void>.delayed(Duration(milliseconds: ms));

/// Puts a finger down at [at] for [holdMs] and lifts it.
Future<void> tap(Offset at, int holdMs) async {
  final view = viewId();
  final pointer = _nextPointer++;
  _dispatch(PointerAddedEvent(timeStamp: _now(), viewId: view, device: _device, position: at));
  _dispatch(PointerDownEvent(timeStamp: _now(), viewId: view, device: _device, pointer: pointer, position: at));
  await _sleep(holdMs);
  _dispatch(PointerUpEvent(timeStamp: _now(), viewId: view, device: _device, pointer: pointer, position: at));
  _dispatch(PointerRemovedEvent(timeStamp: _now(), viewId: view, device: _device, position: at));
}

/// Drags a finger from [from] to [to] over [durationMs], a move per frame, and lifts it at the end: a fling when fast.
Future<void> drag(Offset from, Offset to, int durationMs) async {
  final view = viewId();
  final pointer = _nextPointer++;
  _dispatch(PointerAddedEvent(timeStamp: _now(), viewId: view, device: _device, position: from));
  _dispatch(PointerDownEvent(timeStamp: _now(), viewId: view, device: _device, pointer: pointer, position: from));
  final steps = (durationMs / 16).ceil().clamp(2, 240);
  var last = from;
  final started = _clock.elapsedMilliseconds;
  for (var k = 1; k <= steps; k++) {
    // On the clock, not on a count of sleeps: a busy frame must not stretch the gesture and slow a fling down.
    final due = started + durationMs * k ~/ steps;
    final wait = due - _clock.elapsedMilliseconds;
    if (wait > 0) await _sleep(wait);
    final next = Offset.lerp(from, to, k / steps)!;
    _dispatch(
      PointerMoveEvent(
        timeStamp: _now(),
        viewId: view,
        device: _device,
        pointer: pointer,
        position: next,
        delta: next - last,
      ),
    );
    last = next;
  }
  _dispatch(PointerUpEvent(timeStamp: _now(), viewId: view, device: _device, pointer: pointer, position: to));
  _dispatch(PointerRemovedEvent(timeStamp: _now(), viewId: view, device: _device, position: to));
}

EditableTextState? _focusedField() {
  final context = FocusManager.instance.primaryFocus?.context;
  if (context == null || !context.mounted) return null;
  if (context is StatefulElement && context.state is EditableTextState) return context.state as EditableTextState;
  return context.findAncestorStateOfType<EditableTextState>();
}

EditableTextState _field() {
  final field = _focusedField();
  if (field == null || field.widget.readOnly) throw AgentError('No input is focused: pass a target');
  return field;
}

void _deliver(EditableTextState field, TextEditingValue next) {
  final before = field.textEditingValue;
  TextInput.updateEditingValue(next);
  // A field that holds focus without an input connection yet (it attaches on the focus change's microtask) did not
  // get it: hand it to the field the way the connection would have.
  if (field.mounted && field.textEditingValue == before && next != before) field.updateEditingValue(next);
}

/// Types into the focused field where its cursor is, replacing its selection.
void typeText(String text) {
  final field = _field();
  final value = field.textEditingValue;
  final selection = value.selection.isValid ? value.selection : TextSelection.collapsed(offset: value.text.length);
  final next = value.text.replaceRange(selection.start, selection.end, text);
  _deliver(
    field,
    TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: selection.start + text.length),
    ),
  );
}

/// Deletes [count] characters before the cursor of the focused field, as a backspace key would.
void deleteBackward(int count) {
  final field = _field();
  final value = field.textEditingValue;
  final selection = value.selection.isValid ? value.selection : TextSelection.collapsed(offset: value.text.length);
  final String next;
  final int at;
  if (!selection.isCollapsed) {
    next = value.text.replaceRange(selection.start, selection.end, '');
    at = selection.start;
  } else {
    final before = value.text.substring(0, selection.start).characters;
    final kept = before.take(before.length - count.clamp(0, before.length)).string;
    next = kept + value.text.substring(selection.start);
    at = kept.length;
  }
  _deliver(
    field,
    TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: at),
    ),
  );
}

/// The return key of the focused field: its own action, or done where the key would only add a line.
void submit() {
  final field = _field();
  final action = field.widget.textInputAction;
  field.performAction(action == null || action == TextInputAction.newline ? TextInputAction.done : action);
}

void dismissKeyboard() => FocusManager.instance.primaryFocus?.unfocus();

bool get keyboardFocused => _focusedField() != null;

/// A message on a channel as if the engine had sent it: what the platform does for a back button or a link.
Future<void> fromPlatform(String channel, MethodCall call) {
  final done = Completer<void>();
  ServicesBinding.instance.channelBuffers.push(channel, const JSONMethodCodec().encodeMethodCall(call), (_) {
    if (!done.isCompleted) done.complete();
  });
  return done.future.timeout(const Duration(seconds: 2), onTimeout: () {});
}
