import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/scheduler.dart';

import 'item.dart';
import 'link.dart';
import 'matching.dart';
import 'snapshot.dart';

typedef Command = FutureOr<Object?> Function(Object? params);

int _ms() => clock.now().millisecondsSinceEpoch;

const _keep = 500;

// Reads would drown the timeline; only actions are worth a line.
const _untraced = {'screen', 'find', 'trace', 'requests', 'ping', 'debug', 'idle', 'waitFor', 'busy'};

Map<String, Object?> _params(Object? params) => params is Map ? params.cast<String, Object?>() : const {};

int? _int(Object? v) => v is num ? v.toInt() : null;

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
    return snapshot;
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
      case 'trace':
        final since = _int(p['since']);
        return {
          'last': _nextSeq - 1,
          'events': since == null ? _trace : _trace.where((e) => (e['seq']! as int) > since).toList(),
        };
      case 'debug':
        return {...debugTree(), 'frames': _frames, 'commit': _commit};
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
}
