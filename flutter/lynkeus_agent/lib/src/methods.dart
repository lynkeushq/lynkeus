import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'item.dart';
import 'link.dart';
import 'matching.dart';
import 'snapshot.dart';
import 'touch.dart' as touch;

typedef Command = FutureOr<Object?> Function(Object? params);

int _ms() => clock.now().millisecondsSinceEpoch;
Future<void> _sleep(int ms) => Future<void>.delayed(Duration(milliseconds: ms));

// 30 looks 40 ms apart: 1.2 s on a real clock, inside settle's 3 s deadline.
const _minSettleLooks = 30;
const _keep = 500;

// Reads would drown the timeline; only actions are worth a line.
const _untraced = {'screen', 'find', 'trace', 'requests', 'ping', 'debug', 'idle', 'waitFor', 'busy'};

String _describe(Target target) => jsonEncode(target.toJson());

// Within a point is the same place: a breathing CTA is not a transition.
bool _sameFrame(Item a, Item b) =>
    (a.frame.left - b.frame.left).abs() < 1 &&
    (a.frame.top - b.frame.top).abs() < 1 &&
    (a.frame.width - b.frame.width).abs() < 1 &&
    (a.frame.height - b.frame.height).abs() < 1;

class _Point {
  _Point(this.x, this.y, [this.element]);
  final double x;
  final double y;
  final Item? element;
  Map<String, Object?> toJson() => {'x': x, 'y': y, if (element != null) 'element': element!.toJson()};
}

Map<String, Object?> _params(Object? params) => params is Map ? params.cast<String, Object?>() : const {};

int? _int(Object? v) => v is num ? v.toInt() : null;
double? _double(Object? v) => v is num ? v.toDouble() : null;
Offset? _offset(Object? v) {
  if (v is! Map) return null;
  final x = _double(v['x']);
  final y = _double(v['y']);
  return x == null || y == null ? null : Offset(x, y);
}

Map<String, Object?> _xy(Offset o) => {'x': o.dx, 'y': o.dy};

/// The protocol's methods (docs/PROTOCOL.md), answered from the live widget tree.
class Methods {
  Methods() {
    SchedulerBinding.instance.addPersistentFrameCallback((_) => _frames++);
  }

  final commands = <String, Command>{};

  /// Requests the app has in flight; the network layer sets it.
  int Function() inFlight = () => 0;

  /// The focused route's name; a navigator observer sets it.
  String? Function() currentRoute = () => null;

  int _frames = 0;
  int _commit = 0;
  int _lookedAt = -1;
  String _digest = '';

  final _trace = <Map<String, Object?>>[];
  int _nextSeq = 1;

  List<String> commandNames() => commands.keys.toList()..sort();

  void record(Map<String, Object?> event) {
    _trace.add({'seq': _nextSeq++, 't': _ms(), ...event});
    if (_trace.length > _keep) _trace.removeAt(0);
  }

  // A count of the changes the screen went through: a frame that moved, added or changed what is listed counts, a
  // spinner turning does not, so a screen with an endless animation still goes idle.
  Snapshot _snapshot() {
    final snapshot = takeSnapshot();
    final digest = snapshot.elements
        .map(
          (e) =>
              '${e.kind}|${e.testId}|${e.text}|${e.value}|${e.frame.left.round()},${e.frame.top.round()},${e.frame.width.round()},${e.frame.height.round()}|${e.enabled}|${e.hidden}|${e.focused}|${e.covered}',
        )
        .join('\n');
    if (digest != _digest) {
      _digest = digest;
      _commit++;
    }
    _lookedAt = _frames;
    return snapshot;
  }

  int _commitCount() {
    if (_frames != _lookedAt) _snapshot();
    return _commit;
  }

  List<Item> _elements() => _snapshot().elements;

  Future<bool> _busy() async {
    if (inFlight() > 0) return true;
    final custom = commands['busy'];
    if (custom == null) return false;
    try {
      return await custom(null) == true;
    } catch (_) {
      return false;
    }
  }

  Future<Object?> call(String method, Object? params) async {
    final started = _ms();
    try {
      final result = await _dispatch(method, params);
      if (!_untraced.contains(method)) record({'kind': 'command', 'method': method, 'ms': _ms() - started});
      return result;
    } catch (error) {
      record({'kind': 'command', 'method': method, 'ms': _ms() - started, 'error': '$error'});
      rethrow;
    }
  }

  Future<Object?> _dispatch(String method, Object? params) async {
    final p = _params(params);
    switch (method) {
      case 'ping':
        return {'pong': true, 'native': true, 'commands': commandNames()};
      case 'screen':
        return _screen();
      case 'find':
        return find(Target.parse(params))?.toJson();
      case 'press':
        return _press(p);
      case 'type':
        return _type(p);
      case 'swipe':
        return _swipe(p);
      case 'waitFor':
        return _waitFor(p);
      case 'idle':
        return _idle(p);
      case 'back':
        return _back();
      case 'deepLink':
        final url = p['url'];
        if (url is! String || url.isEmpty) throw AgentError('deepLink needs a url');
        await touch.fromPlatform(
          'flutter/navigation',
          MethodCall('pushRouteInformation', {'location': url, 'state': null}),
        );
        return {'opened': url};
      case 'dismissKeyboard':
        touch.dismissKeyboard();
        return true;
      case 'trace':
        final since = _int(p['since']);
        return {
          'last': _nextSeq - 1,
          'events': since == null ? _trace : _trace.where((e) => (e['seq']! as int) > since).toList(),
        };
      case 'debug':
        return {...debugTree(), 'frames': _frames, 'commit': _commit};
      case 'batch':
        final calls = p['calls'];
        if (calls is! List) throw AgentError('batch needs calls: [{ method, params? }]');
        final results = <Object?>[];
        for (final call in calls) {
          final c = _params(call);
          final name = c['method'];
          if (name is! String) throw AgentError('batch: each call needs a method');
          results.add(await _dispatch(name, c['params']));
        }
        return {'results': results};
    }
    final custom = commands[method];
    if (custom != null) return await custom(params);
    throw AgentError('Unknown method $method');
  }

  Future<Map<String, Object?>> _screen() async {
    final started = _ms();
    final snapshot = _snapshot();
    return {
      'path': const <String>[],
      'elements': [for (final e in snapshot.elements) e.toJson()],
      'commit': _commit,
      'busy': await _busy(),
      'window': {'w': snapshot.window.width, 'h': snapshot.window.height},
      'presenting': ?snapshot.presenting,
      'costMs': _ms() - started,
    };
  }

  Item? find(Target target) => pick(_elements(), target);

  Item _presented(Target target) {
    final element = find(target);
    if (element == null) throw AgentError('No element matches ${_describe(target)}');
    if (element.hidden != null) throw AgentError('${_describe(target)} is not presented (${element.hidden})');
    return element;
  }

  _Point _pointOf(Target target) {
    if (target.isPoint) return _Point(target.x!, target.y!);
    final element = _presented(target);
    return _Point(element.cx, element.cy, element);
  }

  bool _inWindow(Item e) {
    final w = windowSize();
    return !e.offscreen && e.cx >= 0 && e.cy >= 0 && e.cx <= w.width && e.cy <= w.height;
  }

  // An element still sliding in would be tapped where it was. Two identical measurements 40 ms apart mean it has
  // landed. A fling coasts for a while, and a finger that lands on it stops the scroll where it is: wait it out, or
  // the screen depends on when the tap came.
  Future<_Point> _settled(Target target, {int timeoutMs = 3000}) async {
    final deadline = _ms() + timeoutMs;
    var looks = 0;
    bool waiting() => _ms() < deadline || looks < _minSettleLooks;
    // A control still becoming interactive (a sheet sliding in) reads as inert for a moment: wait it out within the
    // same deadline before calling it not presented.
    bool inert() => !target.isPoint && find(target)?.hidden == 'inert';
    _Point? look() {
      try {
        return _pointOf(target);
      } on AgentError catch (error) {
        if (waiting() && error.message.endsWith('is not presented (inert)')) return null;
        rethrow;
      }
    }

    while (inert() && waiting()) {
      looks++;
      await _sleep(40);
    }
    var previous = look();
    while (waiting()) {
      looks++;
      await _sleep(40);
      if (inert()) continue;
      final current = look();
      if (current == null) continue;
      final before = previous?.element;
      if (current.element == null || (before != null && _sameFrame(current.element!, before))) return current;
      previous = current;
    }
    return previous ?? _pointOf(target);
  }

  Future<_Point> _pressNative(Target target, int holdMs) async {
    var point = await _settled(target);
    // With the keyboard up, a tap outside the field may only dismiss it: close it first and measure again once the
    // layout moves back.
    if (point.element?.kind != 'input' && _elements().any((e) => e.focused)) {
      touch.dismissKeyboard();
      await _sleep(300);
      point = await _settled(target);
    }
    await touch.tap(Offset(point.x, point.y), holdMs);
    return point;
  }

  Future<Map<String, Object?>> _press(Map<String, Object?> p) async {
    final target = Target.parse(p);
    // A finger cannot reach what is outside the window, so bring it in first.
    final known = target.isPoint ? null : find(target);
    if (known != null && known.hidden == null && !_inWindow(known)) {
      await _waitFor({'target': target.toJson(), 'scroll': true, 'timeoutMs': 5000});
    }
    return {...(await _pressNative(target, _int(p['holdMs']) ?? 50)).toJson(), 'mode': 'native'};
  }

  Future<Map<String, Object?>> _type(Map<String, Object?> p) async {
    final text = p['text'];
    if (text is! String) throw AgentError('type needs text');
    final targetJson = p['target'];
    final target = targetJson == null ? null : Target.parse(targetJson);
    Item? element;
    if (target != null) {
      final found = find(target);
      if (found?.kind == 'input' && found?.hidden == 'inert') {
        element = found;
      } else {
        element = (await _pressNative(target, 50)).element;
        // The field needs a frame to take focus and attach to the keyboard before it accepts input.
        await _sleep(80);
        // A screen that makes room for the keyboard moves the field meanwhile; wait it out like a person would.
        await _settled(target);
      }
    }
    if (p['clear'] == true) {
      final current = _elements().where((e) => e.focused).firstOrNull?.value ?? element?.value ?? '';
      if (current.isNotEmpty) touch.deleteBackward(current.characters.length);
    }
    if (p['paste'] == true) {
      touch.typeText(text);
    } else {
      // A field that formats on every change races keys that come faster than a frame.
      for (final char in text.characters) {
        touch.typeText(char);
        await _sleep(25);
      }
    }
    if (p['submit'] == true) touch.submit();
    return {'typed': text, if (element != null) 'element': element.toJson()};
  }

  Future<Map<String, Object?>> _swipe(Map<String, Object?> p) async {
    final window = windowSize();
    final width = window.width;
    final height = window.height;
    final durationMs = _int(p['durationMs']) ?? 250;
    final direction = p['direction'] is String ? p['direction'] as String : null;
    if (p['target'] != null) {
      final target = Target.parse(p['target']);
      final landed = await _settled(target);
      final element = landed.element ?? _presented(target);
      final dir = direction ?? 'up';
      final distance = _double(p['distance']) ?? (dir == 'up' || dir == 'down' ? height : width) * 0.6;
      final dx = dir == 'left' ? -distance : (dir == 'right' ? distance : 0.0);
      final dy = dir == 'up' ? -distance : (dir == 'down' ? distance : 0.0);
      // Keep the finger inside the target, and clip the end at the window, using the edge that maximizes the drag.
      const inset = 8.0;
      final f = element.frame;
      var fromX = dx < 0 ? f.right - inset : (dx > 0 ? f.left + inset : element.cx);
      var fromY = dy < 0 ? f.bottom - inset : (dy > 0 ? f.top + inset : element.cy);
      fromX = fromX.clamp(inset, width - inset);
      fromY = fromY.clamp(inset, height - inset);
      final from = Offset(fromX, fromY);
      final to = Offset((fromX + dx).clamp(inset, width - inset), (fromY + dy).clamp(inset, height - inset));
      await touch.drag(from, to, durationMs);
      return {'from': _xy(from), 'to': _xy(to), 'settledMs': await _scrollsSettled()};
    }
    final presets = {
      'up': (Offset(width / 2, height * 0.7), Offset(width / 2, height * 0.3)),
      'down': (Offset(width / 2, height * 0.3), Offset(width / 2, height * 0.7)),
      'left': (Offset(width * 0.8, height / 2), Offset(width * 0.2, height / 2)),
      'right': (Offset(width * 0.2, height / 2), Offset(width * 0.8, height / 2)),
    };
    final preset = direction == null ? null : presets[direction];
    final from = _offset(p['from']) ?? preset?.$1;
    final to = _offset(p['to']) ?? preset?.$2;
    if (from == null || to == null) throw AgentError('swipe needs a direction, a target, or from/to points');
    await touch.drag(from, to, durationMs);
    return {'from': _xy(from), 'to': _xy(to), 'settledMs': await _scrollsSettled()};
  }

  // Where every scroller is, and whether one is still moving on its own.
  List<double> _scrollState() {
    final out = <double>[];
    void visit(Element e) {
      if (e is StatefulElement && e.state is ScrollableState) {
        final position = (e.state as ScrollableState).position;
        out.add(position.hasPixels ? position.pixels : -1);
        if (position.isScrollingNotifier.value) out.add(double.infinity);
      }
      e.visitChildren(visit);
    }

    WidgetsBinding.instance.rootElement?.visitChildren(visit);
    return out;
  }

  // A swipe answers once what it set moving has stopped: a fling coasting, a header collapsing. On a device the time
  // between two commands usually covers it; on a host whose clock barely moves between commands it does not, and the
  // next swipe would land on a list still moving. Still for 120 ms, as the scroll in waitFor; a scroller that never
  // stops (an auto-advancing carousel) is let go after 3 s.
  Future<int> _scrollsSettled({int timeoutMs = 3000}) async {
    final started = _ms();
    var last = _scrollState();
    var stillSince = _ms();
    while (_ms() - started < timeoutMs) {
      await _sleep(40);
      final now = _scrollState();
      if (now.contains(double.infinity) || !listEquals(now, last)) {
        last = now;
        stillSince = _ms();
      } else if (_ms() - stillSince >= 120) {
        break;
      }
    }
    return _ms() - started;
  }

  // Towards an element that is known but outside the window, or onwards when it has not been built yet; over its own
  // scroller when it has one.
  Future<void> _swipeTowards(List<Item> all, Item? target, bool back) async {
    final win = windowSize();
    Item? scroller;
    for (var p = target?.parent; p != null && scroller == null; p = all[p].parent) {
      if (all[p].kind == 'scroll') scroller = all[p];
    }
    if (scroller == null) {
      final scrolls = all.where((e) => e.kind == 'scroll' && e.hidden == null).toList()
        ..sort((a, b) => (b.frame.width * b.frame.height).compareTo(a.frame.width * a.frame.height));
      scroller = scrolls.firstOrNull;
    }
    final box = scroller?.frame ?? Offset.zero & win;
    final left = math.max(box.left, 0.0);
    final top = math.max(box.top, 0.0);
    final right = math.min(box.right, win.width);
    final bottom = math.min(box.bottom, win.height);
    final cx = (left + right) / 2;
    final cy = (top + bottom) / 2;
    final dx = (right - left) * 0.3;
    final dy = (bottom - top) * 0.3;
    final at = target == null ? null : Offset(target.cx, target.cy);
    // The finger travels along the target's own row or column: a drag anywhere else on the scroller may belong to
    // something else (a pager of tabs).
    if (at != null && (at.dx < 0 || at.dx > win.width) && at.dy >= 0 && at.dy <= win.height) {
      final forward = at.dx > win.width;
      await touch.drag(Offset(cx + (forward ? dx : -dx), at.dy), Offset(cx + (forward ? -dx : dx), at.dy), 250);
      return;
    }
    final up = at == null ? back : at.dy < top;
    final x = at == null ? cx : at.dx.clamp(left + 1, right - 1);
    await touch.drag(Offset(x, cy + (up ? -dy : dy)), Offset(x, cy + (up ? dy : -dy)), 250);
  }

  Future<Map<String, Object?>> _waitFor(Map<String, Object?> p) async {
    final target = p['target'] == null ? null : Target.parse(p['target']);
    final anyOf = p['anyOf'] is List ? (p['anyOf']! as List).map(Target.parse).toList() : null;
    final gone = p['gone'] == true;
    final enabled = p['enabled'] is bool ? p['enabled'] as bool : null;
    final scroll = p['scroll'] == true;
    final route = p['route'] is String ? p['route'] as String : null;
    if (anyOf != null && gone) throw AgentError('waitFor: gone takes one target, not anyOf');
    var swipes = 0;
    var lastSwipe = 0;
    // A target that is not built yet gives no direction: go down until the list stops moving, then back up, and give
    // up when that stops moving too.
    var back = false;
    var before = '';
    var moving = '';
    var movedAt = 0;
    String shape(List<Item> all) => all.map((e) => '${e.testId ?? e.text ?? ''}@${e.frame.top.round()}').join('|');
    final started = _ms();
    final deadline = started + (_int(p['timeoutMs']) ?? 5000);
    while (true) {
      final current = currentRoute();
      final routeOk = route == null || current == route;
      final all = target != null || anyOf != null ? _elements() : <Item>[];
      final found = target == null ? null : pick(all, target);
      // Enabled means it takes a touch now: a control under something that blocks touches reads as enabled but inert.
      bool stateOk(Item? e) =>
          e != null && (enabled == null || (e.enabled == enabled && (!enabled || e.hidden != 'inert')));
      final present = target == null ? true : stateOk(found) && !(scroll && !_inWindow(found!));
      final targetOk = gone ? !present : present;
      final matched = anyOf?.where((t) => stateOk(pick(all, t))).firstOrNull;
      final anyOk = anyOf == null || matched != null;
      if (routeOk && targetOk && anyOk) {
        return {'route': ?current, if (matched != null) 'matched': matched.toJson(), 'waitedMs': _ms() - started};
      }
      if (_ms() > deadline) {
        throw AgentError(
          'Timed out waiting for ${route ?? ''} ${target == null ? '' : _describe(target)}${gone ? ' to disappear' : ''} (on $current)',
        );
      }
      // A scroller keeps moving after the finger lifts. The next swipe waits for it to stop, so that whether one more
      // is needed is decided where the scroll ends, not on its way.
      final now = shape(all);
      if (now != moving) {
        moving = now;
        movedAt = _ms();
      }
      final still = _ms() - movedAt >= 120 || _ms() - lastSwipe > 3000;
      if (scroll && target != null && !gone && swipes < 30 && still && _ms() - lastSwipe > 400) {
        if (found == null && swipes > 0 && shape(all) == before) {
          if (back) swipes = 30;
          back = true;
        }
        before = shape(all);
        await _swipeTowards(all, found, back);
        swipes += 1;
        lastSwipe = _ms();
        continue;
      }
      await _sleep(40);
    }
  }

  // Gives up quietly: a screen with a ticking clock never settles, and that is information, not a failure.
  Future<Map<String, Object?>> _idle(Map<String, Object?> p) async {
    final quietMs = _int(p['quietMs']) ?? 150;
    final after = _int(p['after']);
    final deadline = _ms() + (_int(p['timeoutMs']) ?? 3000);
    var lastCommit = _commitCount();
    var quietSince = _ms();
    var arrived = after == null || lastCommit > after;
    while (_ms() < deadline) {
      await _sleep(30);
      final commit = _commitCount();
      if (after != null && commit > after) arrived = true;
      if (commit != lastCommit || await _busy()) {
        lastCommit = commit;
        quietSince = _ms();
      } else if (arrived && _ms() - quietSince >= quietMs) {
        return {'commit': commit, 'idle': true};
      }
    }
    return {'commit': _commitCount(), 'idle': false};
  }

  // The system back: what the engine sends for Android's back button, which pops the top route, a dialog first.
  Future<Map<String, Object?>> _back() async {
    final navigators = <NavigatorState>[];
    void visit(Element e) {
      if (e is StatefulElement && e.state is NavigatorState) navigators.add(e.state as NavigatorState);
      e.debugVisitOnstageChildren(visit);
    }

    final root = WidgetsBinding.instance.rootElement;
    if (root != null) visit(root);
    if (!navigators.any((n) => n.canPop())) throw AgentError('Nothing to go back to');
    await touch.fromPlatform('flutter/navigation', const MethodCall('popRoute'));
    return {};
  }
}
