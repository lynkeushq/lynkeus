import 'dart:ui' show Rect;

import 'package:flutter/rendering.dart' show RenderObject;

/// An `Element` of the protocol (docs/PROTOCOL.md). Named apart from Flutter's own [Element].
class Item {
  Item({
    required this.i,
    required this.kind,
    required this.frame,
    this.enabled = true,
    this.depth = 0,
    this.testId,
    this.text,
    this.accessibilityLabel,
    this.value,
    this.placeholder,
    this.fontSize,
    this.bold = false,
    this.focused = false,
    this.parent,
    this.covered = false,
    this.hidden,
    this.offscreen = false,
    this.renderObject,
  });

  int i;
  final String kind;
  final Rect frame;
  bool enabled;
  final int depth;
  String? testId;
  String? text;
  String? accessibilityLabel;
  String? value;
  String? placeholder;
  double? fontSize;
  bool bold;
  bool focused;
  int? parent;
  bool covered;

  /// `a11y`, `inert`, `behind-modal` or `behind-overlay`.
  String? hidden;
  bool offscreen;

  /// What a hit test has to reach for a touch at the centre to land on this element.
  final RenderObject? renderObject;

  double get cx => frame.left + frame.width / 2;
  double get cy => frame.top + frame.height / 2;

  Map<String, Object?> toJson() => {
    'i': i,
    'kind': kind,
    'frame': {'x': _round(frame.left), 'y': _round(frame.top), 'w': _round(frame.width), 'h': _round(frame.height)},
    'enabled': enabled,
    'depth': depth,
    'testId': ?testId,
    'text': ?text,
    'accessibilityLabel': ?accessibilityLabel,
    'value': ?value,
    'placeholder': ?placeholder,
    if (fontSize != null) 'font': {'size': _round(fontSize!), if (bold) 'bold': true},
    if (focused) 'focused': true,
    'parent': ?parent,
    if (covered) 'covered': true,
    'hidden': ?hidden,
    if (offscreen) 'offscreen': true,
  };
}

double _round(double v) => v.isFinite ? (v * 100).roundToDouble() / 100 : 0;

/// What a request points at: `{testId}`, `{text}` (either with `nth` and `within`), `{i}` or `{x, y}`.
class Target {
  const Target({this.testId, this.text, this.i, this.x, this.y, this.nth, this.within});

  final String? testId;
  final String? text;
  final int? i;
  final double? x;
  final double? y;
  final int? nth;
  final Target? within;

  bool get isPoint => testId == null && text == null && i == null && x != null && y != null;

  static Target parse(Object? json) {
    if (json is! Map) throw ArgumentError('A target is {testId}, {text}, {i} or {x, y}, not ${_describe(json)}');
    final within = json['within'];
    final target = Target(
      testId: json['testId'] is String ? json['testId'] as String : null,
      text: json['text'] is String ? json['text'] as String : null,
      i: json['i'] is num ? (json['i'] as num).toInt() : null,
      x: json['x'] is num ? (json['x'] as num).toDouble() : null,
      y: json['y'] is num ? (json['y'] as num).toDouble() : null,
      nth: json['nth'] is num ? (json['nth'] as num).toInt() : null,
      within: within == null ? null : Target.parse(within),
    );
    if (target.testId == null && target.text == null && target.i == null && !target.isPoint) {
      throw ArgumentError('A target is {testId}, {text}, {i} or {x, y}, not ${_describe(json)}');
    }
    return target;
  }

  Target withoutScope() => Target(testId: testId, text: text, i: i, x: x, y: y, nth: nth);

  Map<String, Object?> toJson() => {
    'testId': ?testId,
    'text': ?text,
    'i': ?i,
    'x': ?x,
    'y': ?y,
    'nth': ?nth,
    if (within != null) 'within': within!.toJson(),
  };
}

String _describe(Object? value) => value is Map ? value.toString() : '$value';
