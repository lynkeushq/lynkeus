import 'dart:collection';
import 'dart:ui' show FlutterView;

import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

import 'item.dart';

/*
 * The screen as Flutter has it, in one pass over the element tree: what is listed, where it stands (from its render
 * object, in logical points), and what a finger at its center would reach (Flutter's own hit test).
 *
 * Only the widgets layer is read: Material and Cupertino now ship as packages of their own (material_ui,
 * cupertino_ui) beside the deprecated copies in the SDK, so a type check against one ElevatedButton misses the other.
 * What every one of them shares is what it tells assistive technology: a button, a toggle and a text field each
 * build a Semantics widget that says so, and taps end in a GestureDetector.
 *
 * Only what is onstage is walked (`debugVisitOnstageChildren`, what flutter_test's finders use to skip offstage): the
 * routes under an opaque one, an Offstage subtree, an IndexedStack's other children, the rows a lazy list keeps built
 * beyond the viewport.
 */

class Snapshot {
  Snapshot(this.elements, this.presenting, this.window);
  final List<Item> elements;
  final Map<String, Object?>? presenting;
  final Size window;
}

/// What a widget is to the agent.
class _Role {
  const _Role(this.kind, {this.enabled, this.label, this.own, this.generic = false});
  final String kind;

  /// Null when the widget does not say (a Semantics without `enabled`).
  final bool? enabled;
  final String? label;

  /// Where the control's own implementation ends and the app's content begins (a GestureDetector's child); null when
  /// all of it is the control's (a Material button's Semantics).
  final Widget? own;

  /// A bare tap handler: a button only when it holds no other control (a card with a like button is not one).
  final bool generic;

  bool get control => kind == 'button' || kind == 'input' || kind == 'switch';
}

bool _taps(GestureDetector w) =>
    w.onTap != null ||
    w.onTapDown != null ||
    w.onTapUp != null ||
    w.onLongPress != null ||
    w.onDoubleTap != null ||
    w.onSecondaryTap != null;

// Material's text field (the SDK's or material_ui's) wraps the whole decorated field in a Semantics that reports the
// value's length. Cupertino's says nothing that sets it apart from any other tappable box, so it is known by name, the
// same in the SDK and in cupertino_ui.
bool _isField(Widget w) {
  if (w is Semantics) return w.properties.currentValueLength != null || w.properties.maxValueLength != null;
  return w.runtimeType.toString() == 'CupertinoTextField';
}

_Role? _roleOf(Element e) {
  final w = e.widget;
  if (w is RichText) return const _Role('text');
  if (w is EditableText) return _Role(w.readOnly ? 'text' : 'input');
  if (w is Icon) return _Role('image', label: w.semanticLabel);
  if (w is Image) return _Role('image', label: w.semanticLabel);
  if (w is Scrollable) return const _Role('scroll');
  if (_isField(w)) return _Role('input', enabled: w is Semantics ? w.properties.enabled ?? true : true);
  if (w is Semantics) {
    final p = w.properties;
    if (p.button ?? false) return _Role('button', enabled: p.enabled, label: p.label ?? p.tooltip);
    if (p.toggled != null || p.checked != null) return _Role('switch', enabled: p.enabled, label: p.label);
  }
  if (w is GestureDetector && _taps(w)) return _Role('button', enabled: true, own: w.child, generic: true);
  return null;
}

String? _keyOf(Widget w) {
  final key = w.key;
  return key is ValueKey<String> && key.value.isNotEmpty ? key.value : null;
}

String? _clean(String? text) {
  if (text == null) return null;
  final t = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  return t.isEmpty ? null : (t.length > 200 ? t.substring(0, 200) : t);
}

String _plain(RichText w) => w.text.toPlainText(includeSemanticsLabels: false, includePlaceholders: false);

Rect? _frameOf(RenderObject? ro) {
  if (ro == null || !ro.attached) return null;
  if (ro is RenderBox && !ro.hasSize) return null;
  if (ro is RenderSliver && ro.geometry == null) return null;
  try {
    final rect = MatrixUtils.transformRect(ro.getTransformTo(null), ro.paintBounds);
    return rect.isFinite ? rect : null;
  } catch (_) {
    return null;
  }
}

// Faded out is not presented, though Flutter still hit tests it.
bool _invisible(Element e) {
  if (e is! RenderObjectElement) return false;
  final ro = e.renderObject;
  if (ro is RenderOpacity) return ro.opacity == 0;
  if (ro is RenderAnimatedOpacityMixin) return ro.opacity.value == 0;
  return false;
}

// Read from the render object, not the widget: a Scrollable turns its IgnorePointer on during a drag or a fling and
// off again by setting the render object, with no rebuild, so the widget can say the opposite of what a touch meets.
bool _blocksTouches(Element e) {
  if (e is! RenderObjectElement) return false;
  final ro = e.renderObject;
  return (ro is RenderIgnorePointer && ro.ignoring) || (ro is RenderAbsorbPointer && ro.absorbing);
}

Element? _onlyChild(Element e) {
  Element? only;
  var count = 0;
  e.visitChildElements((c) {
    only = c;
    count++;
  });
  return count == 1 ? only : null;
}

List<Element> _onstage(Element e) {
  final out = <Element>[];
  e.debugVisitOnstageChildren(out.add);
  return out;
}

/// What a key or a Semantics identifier names when its widget is not listed itself: the first listed element down
/// its chain of single children (`Text` → `RichText`, `TextField` → its field, `ListView` → `Scrollable`).
Element? _named(Element from) {
  Element? at = from;
  for (var steps = 0; steps < 40; steps++) {
    at = _onlyChild(at!);
    if (at == null) return null;
    if (_roleOf(at) != null) return at;
  }
  return null;
}

bool _hasBarrier(Element e, int depth) {
  if (e.widget is ModalBarrier || e.widget is AnimatedModalBarrier) return true;
  if (depth == 0) return false;
  var found = false;
  e.visitChildElements((c) {
    if (!found && _hasBarrier(c, depth - 1)) found = true;
  });
  return found;
}

// A disabled control takes no touch, so a tap handler around one (an InkWell over an IconButton with no onPressed) is
// what a finger meets: the handler stays the button.
bool _holdsControl(Element e) {
  var found = false;
  e.visitChildElements((c) {
    if (found) return;
    final role = _roleOf(c);
    found = (role != null && role.control && role.enabled != false) || _holdsControl(c);
  });
  return found;
}

// Material's InputDecorator puts each part of a field in a named slot: the hint, the floating label, the helper or
// error line, the app's own prefix and suffix.
String? _decorationSlot(Element e) {
  final slot = e.slot?.toString();
  if (slot == null || !slot.startsWith('_DecorationSlot.')) return null;
  return slot.substring('_DecorationSlot.'.length);
}

class _Region {
  _Region(this.owner, this.kind, this.own);

  /// Null when the control itself is not listed (outside the window): its parts are still not listed apart.
  final Item? owner;
  final String kind;
  final Widget? own;
}

class _At {
  const _At({
    required this.clip,
    this.depth = 0,
    this.owner,
    this.hidden,
    this.inButton = false,
    this.region,
    this.sink,
    this.slot,
    this.actionsEnabled,
  });

  /// Where the element can be seen: the window, cut down by every scroll viewport around it.
  final Rect clip;
  final int depth;
  final int? owner;
  final String? hidden;

  /// Inside a control's content: its texts are the control's label, not listed apart.
  final bool inButton;

  /// Inside a control's own implementation (the GestureDetector in a Material button, the EditableText in a field).
  final _Region? region;
  final Item? sink;

  /// The InputDecorator slot this part of a field sits in.
  final String? slot;

  /// A FocusableActionDetector's `enabled` above: how a Cupertino button says it is disabled.
  final bool? actionsEnabled;

  _At copyWith({
    Rect? clip,
    int? depth,
    int? owner,
    String? hidden,
    bool? inButton,
    _Region? region,
    bool clearRegion = false,
    Item? sink,
    String? slot,
    bool? actionsEnabled,
  }) => _At(
    clip: clip ?? this.clip,
    depth: depth ?? this.depth,
    owner: owner ?? this.owner,
    hidden: hidden ?? this.hidden,
    inButton: inButton ?? this.inButton,
    region: clearRegion ? null : (region ?? this.region),
    sink: sink ?? this.sink,
    slot: slot ?? this.slot,
    actionsEnabled: actionsEnabled ?? this.actionsEnabled,
  );
}

class _Walker {
  _Walker(this.window);

  final Size window;
  final items = <Item>[];
  final layers = <int>[];
  final _texts = HashMap<Item, List<String>>.identity();
  final _testIds = HashMap<Element, String>.identity();
  final _labels = HashMap<Element, String>.identity();
  int visited = 0;

  /// What an OverlayPortal shows (a menu, a tooltip): built under its anchor, drawn in the Overlay on top of the page.
  final _deferred = <(Element, _At)>[];

  /// Walks what OverlayPortals put on top, after everything else: apart from its anchor (a menu's items are not the
  /// text of the button that opened it), and later in the listing, as it draws over the rest.
  void walkDeferred() {
    while (_deferred.isNotEmpty) {
      final (e, at) = _deferred.removeAt(0);
      walkChildren(e, at);
    }
  }

  void walkChildren(Element e, _At at) {
    for (final child in _onstage(e)) {
      walk(child, at);
    }
  }

  void walk(Element e, _At inherited) {
    visited++;
    final w = e.widget;
    if (_invisible(e)) return;
    // OverlayPortal's overlay child, a private widget of the framework's.
    if (w.runtimeType.toString() == '_DeferredLayout') {
      _deferred.add((e, _At(clip: Offset.zero & window, hidden: inherited.hidden)));
      return;
    }

    var at = inherited;
    final region = at.region;
    if (region != null && region.own != null && identical(region.own, w)) {
      at = at.copyWith(clearRegion: true, inButton: region.kind != 'input');
    }
    if (at.hidden == null && _blocksTouches(e)) at = at.copyWith(hidden: 'inert');
    if (w is FocusableActionDetector) at = at.copyWith(actionsEnabled: w.enabled);

    if (w is Overlay) {
      final theater = _onlyChild(e);
      if (theater != null) {
        _walkOverlay(theater, at);
        return;
      }
    }

    if (at.region != null) {
      _walkImplementation(e, at);
      return;
    }

    var role = _roleOf(e);
    if (role != null && role.generic && _holdsControl(e)) role = null;
    final ownKey = _keyOf(w);
    var testId = ownKey ?? _testIds[e];
    var label = _labels[e];

    if (role == null) {
      final identifier = w is Semantics ? w.properties.identifier : null;
      final semanticLabel = w is Semantics ? (w.properties.label ?? w.properties.tooltip) : null;
      final names = ownKey != null || (identifier?.isNotEmpty ?? false) || (semanticLabel?.isNotEmpty ?? false);
      final consumer = names ? _named(e) : null;
      if (consumer != null) {
        if (_keyOf(consumer.widget) == null) {
          final id = ownKey ?? (identifier?.isNotEmpty ?? false ? identifier : null);
          if (id != null) _testIds[consumer] ??= id;
        }
        if (semanticLabel != null && semanticLabel.isNotEmpty) _labels[consumer] ??= semanticLabel;
        if (ownKey != null) testId = null;
      } else if (identifier != null && identifier.isNotEmpty) {
        testId ??= identifier;
        label ??= _clean(semanticLabel);
      }
      if (testId == null) {
        walkChildren(e, at);
        return;
      }
      role = const _Role('view');
    }

    final kind = role.kind;
    // A paragraph made of widgets in its spans (a markdown list: a bullet and a nested paragraph per item) says
    // nothing itself: what it shows is in those widgets, which are its children.
    if (w is RichText && testId == null && label == null && _clean(_plain(w)) == null) {
      walkChildren(e, at);
      return;
    }
    if (kind == 'text' && at.inButton) {
      _absorbText(at.sink, w);
      if (w is RichText) walkChildren(e, at);
      if (testId == null && label == null) return;
    }
    if (kind == 'image' && testId == null && role.label == null && label == null) return;

    final frame = _frameOf(e.renderObject);
    final visible = frame?.intersect(at.clip);
    final shown =
        frame != null &&
        frame.width > 0 &&
        frame.height > 0 &&
        visible != null &&
        visible.width > 0 &&
        visible.height > 0;
    if (!shown) {
      // Not listed, but its subtree may still draw outside it; the control's own parts stay unlisted.
      if (kind != 'text' && kind != 'image') {
        walkChildren(e, role.control ? at.copyWith(region: _Region(null, kind, role.own)) : at);
      }
      return;
    }

    final item = Item(
      i: items.length,
      kind: kind,
      frame: frame,
      enabled: role.enabled ?? (kind == 'button' ? at.actionsEnabled ?? true : true),
      depth: at.depth,
      testId: testId,
      accessibilityLabel: label ?? _clean(role.label),
      parent: at.owner,
      hidden: at.hidden,
      offscreen: !at.clip.contains(frame.center),
      renderObject: e.renderObject,
    );
    items.add(item);

    if (w is RichText) {
      item.text = _clean(_plain(w));
      _fontFrom(item, w.text.style);
      walkChildren(e, at.copyWith(depth: at.depth + 1, owner: item.i));
      return;
    }
    if (w is EditableText) {
      if (kind == 'text') {
        item.text = _clean(w.controller.text);
        _fontFrom(item, w.style);
      } else {
        _fillFromEditable(item, w);
      }
      return;
    }
    if (kind == 'image') return;

    final pressable = kind == 'button' || kind == 'switch';
    walkChildren(
      e,
      at.copyWith(
        depth: at.depth + 1,
        owner: item.i,
        region: role.control ? _Region(item, kind, role.own) : null,
        clip: kind == 'scroll' ? at.clip.intersect(frame) : null,
        sink: pressable ? item : null,
        inButton: pressable ? true : null,
      ),
    );
    if (pressable) {
      final parts = _texts.remove(item);
      if (parts != null) item.text = _clean(parts.join(' '));
      // An icon-only button is named by its icon's label.
      if (item.text == null && item.accessibilityLabel == null) {
        for (var k = item.i + 1; k < items.length && _descends(items[k], item.i); k++) {
          if (items[k].kind == 'image' && items[k].accessibilityLabel != null) {
            item.accessibilityLabel = items[k].accessibilityLabel;
            break;
          }
        }
      }
    }
  }

  void _absorbText(Item? sink, Widget w) {
    if (sink == null) return;
    final String text;
    final TextStyle? style;
    if (w is RichText) {
      text = _plain(w);
      style = w.text.style;
    } else if (w is EditableText) {
      text = w.controller.text;
      style = w.style;
    } else {
      return;
    }
    (_texts[sink] ??= []).add(text);
    if (sink.fontSize == null) _fontFrom(sink, style);
  }

  /// Inside a control's own parts nothing is listed apart, but they tell the control what it shows: a field's value,
  /// focus, hint and label, a button's text; and a field's error line or its app-given prefix are on screen in their
  /// own right.
  void _walkImplementation(Element e, _At inherited) {
    final w = e.widget;
    final region = inherited.region!;
    final owner = region.owner;
    if (owner == null) {
      walkChildren(e, inherited);
      return;
    }
    if (w is Icon) {
      if (region.kind != 'input' && w.semanticLabel != null) owner.accessibilityLabel ??= _clean(w.semanticLabel);
      return;
    }
    if (w is Semantics) {
      final p = w.properties;
      if (p.enabled == false) owner.enabled = false;
      final label = p.label ?? p.tooltip;
      if (region.kind != 'input' && label != null && label.isNotEmpty) owner.accessibilityLabel ??= _clean(label);
    }
    if (region.kind != 'input') {
      if (w is RichText) {
        _absorbText(owner, w);
        walkChildren(e, inherited);
        return;
      }
      if (_distinct(e, owner)) {
        walk(e, inherited.copyWith(clearRegion: true));
        return;
      }
      walkChildren(e, inherited);
      return;
    }

    final at = switch (_decorationSlot(e)) {
      null => inherited,
      final slot => inherited.copyWith(slot: slot),
    };
    switch (at.slot) {
      case 'prefix' || 'suffix' || 'prefixIcon' || 'suffixIcon' || 'icon' || 'helperError' || 'counter':
        walk(e, at.copyWith(clearRegion: true, inButton: false));
        return;
    }
    if (w is EditableText) {
      _fillFromEditable(owner, w);
      return;
    }
    if (w is RichText) {
      final text = _clean(_plain(w));
      if (text == null) return;
      if (at.slot == 'label') {
        owner.accessibilityLabel ??= text;
      } else if (at.slot == 'hint' || (at.slot == null && owner.value == null)) {
        // Without a decorator to say so (Cupertino's), the text shown in an empty field is its placeholder.
        owner.placeholder ??= text;
      } else {
        walk(e, at.copyWith(clearRegion: true, inButton: false));
      }
      return;
    }
    walkChildren(e, at);
  }

  // A control inside a pressable row (a tile's delete button) is one of its own, where the same control's inner
  // Semantics (an icon button's) covers about the same box. A key inside a control names something the app wants found.
  bool _distinct(Element e, Item owner) {
    if (_keyOf(e.widget) != null) return true;
    final role = _roleOf(e);
    if (role == null || !role.control || role.generic) return false;
    final frame = _frameOf(e.renderObject);
    if (frame == null) return false;
    return frame.width * frame.height < 0.8 * owner.frame.width * owner.frame.height;
  }

  void _fillFromEditable(Item item, EditableText w) {
    final text = w.controller.text;
    if (text.isNotEmpty) item.value = w.obscureText ? '•' * text.characters.length : text;
    if (w.focusNode.hasFocus) item.focused = true;
    _fontFrom(item, w.style);
  }

  void _fontFrom(Item item, TextStyle? style) {
    item.fontSize = style?.fontSize ?? 14;
    item.bold = (style?.fontWeight?.value ?? 400) >= 700;
  }

  /// An Overlay's onstage entries, bottom first. A modal route puts a barrier entry under its page; everything before
  /// the topmost barrier is behind a modal (a page under a dialog, or under a page still sliding in), and the entry
  /// right after it is the layer on top.
  void _walkOverlay(Element theater, _At at) {
    final entries = _onstage(theater);
    var barrier = -1;
    for (var k = entries.length - 1; k >= 0 && barrier < 0; k--) {
      if (_hasBarrier(entries[k], 10)) barrier = k;
    }
    for (var k = 0; k < entries.length; k++) {
      final entry = entries[k];
      if (k < barrier) {
        walk(entry, at.copyWith(hidden: at.hidden ?? 'behind-modal'));
        continue;
      }
      if (barrier > 0 && k == barrier + 1) {
        final frame = _frameOf(entry.renderObject);
        if (frame != null && frame.width > 0 && frame.height > 0) {
          final layer = Item(
            i: items.length,
            kind: 'view',
            frame: frame,
            depth: at.depth,
            parent: at.owner,
            hidden: at.hidden,
          );
          items.add(layer);
          layers.add(layer.i);
          walk(entry, at.copyWith(depth: at.depth + 1, owner: layer.i));
          continue;
        }
      }
      walk(entry, at);
    }
  }

  bool _descends(Item e, int ancestor) {
    for (var p = e.parent; p != null; p = items[p].parent) {
      if (p == ancestor) return true;
    }
    return false;
  }

  Map<String, Object?>? presenting() {
    for (final i in layers.reversed) {
      if (items[i].hidden != null) continue;
      final inside = items.where((e) => e.i > i && _descends(e, i));
      final inhabited = inside.any((e) => e.hidden == null && e.enabled && e.control);
      if (!inhabited) continue;
      final named = inside.where((e) => e.kind == 'view' && e.testId != null).firstOrNull;
      return {'i': i, 'modal': true, 'testId': ?named?.testId};
    }
    return null;
  }

  /// A control is covered when Flutter's own hit test at its center does not pass through it.
  void markCovered(int viewId) {
    for (final e in items) {
      if (e.hidden != null || e.offscreen || e.renderObject == null) continue;
      if (e.kind != 'button' && e.kind != 'input') continue;
      final result = HitTestResult();
      WidgetsBinding.instance.hitTestInView(result, e.frame.center, viewId);
      e.covered = !result.path.any((entry) => identical(entry.target, e.renderObject));
    }
  }
}

extension on Item {
  bool get control => kind == 'button' || kind == 'input' || kind == 'switch';
}

FlutterView _view() {
  final dispatcher = WidgetsBinding.instance.platformDispatcher;
  return dispatcher.implicitView ?? dispatcher.views.first;
}

Size windowSize() {
  final view = _view();
  return view.physicalSize / view.devicePixelRatio;
}

int viewId() => _view().viewId;

_Walker _walkScreen() {
  final window = windowSize();
  final walker = _Walker(window);
  final root = WidgetsBinding.instance.rootElement;
  if (root != null) walker.walk(root, _At(clip: Offset.zero & window));
  walker.walkDeferred();
  walker.markCovered(viewId());
  return walker;
}

/// Everything the app presents, in tree order (later draws on top).
Snapshot takeSnapshot() {
  final walker = _walkScreen();
  return Snapshot(walker.items, walker.presenting(), walker.window);
}

/// The native views on screen (a web view, a map, a native tab bar): their type and their rectangle in window points.
/// The rectangle is the widget's whether or not the platform made the view, so a device and a host, which draws none,
/// report the same place; a pixel comparison masks it on both sides.
List<Map<String, Object?>> platformViews() {
  final out = <Map<String, Object?>>[];
  void visit(Element e) {
    final w = e.widget;
    final type = switch (w) {
      UiKitView() => w.viewType,
      AppKitView() => w.viewType,
      AndroidView() => w.viewType,
      PlatformViewLink() => w.viewType,
      _ => null,
    };
    if (type != null) {
      final frame = _frameOf(e.findRenderObject());
      if (frame != null && !frame.isEmpty) {
        out.add({
          'viewType': type,
          'frame': {'x': frame.left, 'y': frame.top, 'w': frame.width, 'h': frame.height},
        });
      }
      return;
    }
    _onstage(e).forEach(visit);
  }

  final root = WidgetsBinding.instance.rootElement;
  if (root != null) visit(root);
  return out;
}

/// What the walker can see, for when a screen comes back empty or wrong.
Map<String, Object?> debugTree() {
  final watch = Stopwatch()..start();
  final root = WidgetsBinding.instance.rootElement;
  var total = 0;
  final types = <String, int>{};
  void count(Element e) {
    total++;
    final name = e.widget.runtimeType.toString();
    types[name] = (types[name] ?? 0) + 1;
    e.visitChildElements(count);
  }

  if (root != null) count(root);
  final walker = _walkScreen();
  final hiddenBy = <String, int>{};
  for (final e in walker.items) {
    if (e.hidden != null) hiddenBy[e.hidden!] = (hiddenBy[e.hidden!] ?? 0) + 1;
  }
  final top = types.entries.toList()..sort((a, b) => b.value.compareTo(a.value));
  return {
    'runtime': 'flutter',
    'rootPresent': root != null,
    'elements': total,
    'onstage': walker.visited,
    'listed': walker.items.length,
    'presented': walker.items.where((e) => e.hidden == null).length,
    'hiddenBy': hiddenBy,
    'presenting': walker.presenting(),
    'window': {'w': walker.window.width, 'h': walker.window.height},
    'devicePixelRatio': _view().devicePixelRatio,
    'widgetTypes': {for (final t in top.take(40)) t.key: t.value},
    'costMs': watch.elapsedMilliseconds,
  };
}
