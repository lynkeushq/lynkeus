import 'item.dart';

/// How well an element answers a target: 0 = no, higher = better. Exact text on a control beats the same text in a
/// paragraph, and a substring of a paragraph is no target at all: its center lands on whatever word sits there.
int score(Item element, Target target) {
  if (target.testId != null) return element.testId == target.testId ? 4 : 0;
  if (target.i != null) return element.i == target.i ? 4 : 0;
  final text = target.text;
  if (text == null) return 0;
  final needle = text.toLowerCase().trim();
  final haystacks = [element.text, element.accessibilityLabel].whereType<String>().map((v) => v.toLowerCase().trim());
  final control = element.kind == 'button' || element.kind == 'input';
  if (haystacks.any((h) => h == needle)) return control ? 4 : 3;
  if (control && haystacks.any((h) => h.contains(needle))) return 2;
  return 0;
}

// Hidden belongs to another screen or to no one. An inert label inside a pressable is still readable, so it matches;
// it just cannot act.
bool _matchable(Item e) => e.hidden == null || e.hidden == 'inert';

bool _insideOf(List<Item> elements, Item e, int ancestor) {
  for (var p = e.parent; p != null; p = p < elements.length ? elements[p].parent : null) {
    if (p == ancestor) return true;
  }
  return false;
}

// Of several rows with a "like" button, the one that goes with a text shares the smallest container with it, and
// within that container is nearest to it.
Item? _pickWithin(List<Item> elements, Target full) {
  final scope = pick(elements, full.within!);
  if (scope == null) return null;
  final target = full.withoutScope();
  final matches = elements.where((e) => _matchable(e) && score(e, target) > 0).toList();
  Item? container = scope;
  while (true) {
    final level = container;
    final here = level == null
        ? matches
        : matches.where((e) => e.i == level.i || _insideOf(elements, e, level.i)).toList();
    if (here.isNotEmpty) {
      final nth = target.nth;
      if (nth != null) return nth >= 0 && nth < here.length ? here[nth] : null;
      return here.reduce((best, e) {
        final d = (e.i - scope.i).abs();
        final b = (best.i - scope.i).abs();
        return d < b || (d == b && e.i > best.i) ? e : best;
      });
    }
    if (level == null) return null;
    container = level.parent == null ? null : elements[level.parent!];
  }
}

/// Best match for a target. Reachable elements win; a covered one is returned only when nothing reachable matches: an
/// input under the pressable box that focuses it is still on screen, and a tap at its center reaches the box, as a
/// finger would. Ties go to the later element, which draws on top.
Item? pick(List<Item> elements, Target target) {
  if (target.isPoint) return null;
  if (target.within != null) return _pickWithin(elements, target);
  final nth = target.nth;
  if (nth != null) {
    final matches = elements.where((e) => _matchable(e) && score(e, target) > 0).toList();
    return nth >= 0 && nth < matches.length ? matches[nth] : null;
  }
  Item? best;
  var bestRank = 0;
  for (final element in elements) {
    if (!_matchable(element)) continue;
    final s = score(element, target);
    if (s == 0) continue;
    final rank = s + (element.covered ? 0 : 10) + (element.hidden == 'inert' ? 0 : 20);
    if (rank >= bestRank) {
      best = element;
      bestRank = rank;
    }
  }
  return best;
}
