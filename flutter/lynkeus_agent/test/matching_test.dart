import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_agent/src/item.dart';
import 'package:lynkeus_agent/src/matching.dart';

Item el({
  int i = 0,
  String kind = 'view',
  String? testId,
  String? text,
  String? value,
  bool covered = false,
  String? hidden,
  int? parent,
  Rect frame = const Rect.fromLTWH(0, 0, 10, 10),
}) => Item(
  i: i,
  kind: kind,
  frame: frame,
  testId: testId,
  text: text,
  value: value,
  covered: covered,
  hidden: hidden,
  parent: parent,
);

void main() {
  group('score', () {
    test('matches testId exactly', () {
      expect(score(el(testId: 'a'), const Target(testId: 'a')), 4);
      expect(score(el(testId: 'ab'), const Target(testId: 'a')), 0);
    });

    test('prefers exact text on a control over the same text in a paragraph', () {
      final button = el(kind: 'button', text: 'Continue');
      final paragraph = el(kind: 'text', text: 'Continue');
      expect(
        score(button, const Target(text: 'continue')),
        greaterThan(score(paragraph, const Target(text: 'continue'))),
      );
    });

    test('never targets a substring inside a paragraph', () {
      final paragraph = el(kind: 'text', text: 'By tapping Submit you accept the terms');
      expect(score(paragraph, const Target(text: 'accept')), 0);
      final button = el(kind: 'button', text: 'Submit via email');
      expect(score(button, const Target(text: 'submit')), 2);
    });
  });

  group('pick', () {
    test('prefers the one a touch reaches when two share a testId', () {
      final elements = [
        el(i: 0, testId: 'slide', kind: 'button'),
        el(i: 1, testId: 'slide', kind: 'button', hidden: 'inert'),
      ];
      expect(pick(elements, const Target(testId: 'slide'))?.i, 0);
    });

    test('takes the nth of several controls sharing a testId, in tree order, skipping hidden ones', () {
      final elements = [
        el(i: 0, kind: 'input', testId: 'field', value: 'street'),
        el(i: 1, kind: 'input', testId: 'field', hidden: 'behind-modal'),
        el(i: 2, kind: 'input', testId: 'field', value: 'city'),
        el(i: 3, kind: 'input', testId: 'field', value: 'zip'),
      ];
      expect(pick(elements, const Target(testId: 'field', nth: 1))?.i, 2);
      expect(pick(elements, const Target(testId: 'field', nth: 5)), isNull);
    });

    test('prefers reachable elements and takes the later of equal scores', () {
      final elements = [
        el(i: 0, kind: 'button', testId: 'go'),
        el(i: 1, kind: 'button', testId: 'go'),
        el(i: 2, kind: 'button', testId: 'go', covered: true),
      ];
      expect(pick(elements, const Target(testId: 'go'))?.i, 1);
    });

    test('still finds a covered element when nothing reachable matches', () {
      final otp = el(i: 3, kind: 'input', testId: 'hidden-input', covered: true);
      expect(pick([el(kind: 'button', text: 'Paste'), otp], const Target(testId: 'hidden-input')), same(otp));
    });

    test('returns nothing for a point target', () {
      expect(pick([el(testId: 'x')], const Target(x: 1, y: 1)), isNull);
    });
  });

  group('a target within a scope', () {
    Item row(int i, {String kind = 'view', String? testId, String? text, int? parent}) =>
        el(i: i, kind: kind, testId: testId, text: text, parent: parent, frame: Rect.fromLTWH(0, i * 10, 100, 10));
    final feed = [
      row(0, testId: 'feed'),
      row(1, testId: 'row', parent: 0),
      row(2, kind: 'text', text: 'hi from Ana', parent: 1),
      row(3, kind: 'button', testId: 'like-message-button', parent: 1),
      row(4, testId: 'row', parent: 0),
      row(5, kind: 'text', text: 'hi from Beto', parent: 4),
      row(6, kind: 'button', testId: 'like-message-button', parent: 4),
    ];

    test('takes the match in the smallest container around the scope', () {
      expect(
        pick(
          feed,
          const Target(
            testId: 'like-message-button',
            within: Target(text: 'hi from Beto'),
          ),
        )?.i,
        6,
      );
      expect(
        pick(
          feed,
          const Target(
            testId: 'like-message-button',
            within: Target(text: 'hi from Ana'),
          ),
        )?.i,
        3,
      );
    });

    test('with rows that are not listed, takes the match nearest the scope in tree order', () {
      final flat = [
        for (final e in feed)
          if (e.testId != 'row')
            row(
              e.i,
              kind: e.kind,
              testId: e.testId,
              text: e.text,
              parent: e.parent == 1 || e.parent == 4 ? 0 : e.parent,
            ),
      ];
      expect(
        pick(
          flat,
          const Target(
            testId: 'like-message-button',
            within: Target(text: 'hi from Ana'),
          ),
        )?.i,
        3,
      );
      expect(
        pick(
          flat,
          const Target(
            testId: 'like-message-button',
            within: Target(text: 'hi from Beto'),
          ),
        )?.i,
        6,
      );
    });

    test('counts nth inside the scope', () {
      expect(
        pick(
          feed,
          const Target(
            testId: 'like-message-button',
            within: Target(testId: 'feed'),
            nth: 1,
          ),
        )?.i,
        6,
      );
    });

    test('finds nothing when the scope is not there', () {
      expect(
        pick(
          feed,
          const Target(
            testId: 'like-message-button',
            within: Target(text: 'hi from Carla'),
          ),
        ),
        isNull,
      );
    });
  });

  group('parsing a target', () {
    test('reads the shapes the protocol names', () {
      expect(Target.parse({'testId': 'a', 'nth': 1}).toJson(), {'testId': 'a', 'nth': 1});
      expect(
        Target.parse({
          'text': 'Go',
          'within': {'testId': 'row'},
        }).within?.testId,
        'row',
      );
      expect(Target.parse({'x': 10, 'y': 20.5}).isPoint, isTrue);
      expect(Target.parse({'i': 3}).i, 3);
    });

    test('refuses what is not a target', () {
      expect(() => Target.parse({'nope': 1}), throwsArgumentError);
      expect(() => Target.parse('text'), throwsArgumentError);
    });
  });
}
