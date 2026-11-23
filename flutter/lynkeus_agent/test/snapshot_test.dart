import 'package:flutter/services.dart';
// Most apps still import the SDK's Material and Cupertino, deprecated since 3.47 in favor of material_ui and
// cupertino_ui; the walker reads neither, so testing against these covers what the packages build too.
// ignore_for_file: deprecated_member_use

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_agent/src/item.dart';
import 'package:lynkeus_agent/src/snapshot.dart';

Future<List<Item>> screenOf(WidgetTester tester, Widget body) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: body)));
  return takeSnapshot().elements;
}

Item only(List<Item> items, bool Function(Item) test) {
  final found = items.where(test).toList();
  expect(found, hasLength(1), reason: 'listed: ${items.map((e) => e.toJson()).toList()}');
  return found.single;
}

void main() {
  testWidgets('lists a Material button by its key, with its label and state', (tester) async {
    final items = await screenOf(
      tester,
      Column(
        children: [
          ElevatedButton(key: const ValueKey('go'), onPressed: () {}, child: const Text('Add one')),
          const ElevatedButton(key: ValueKey('off'), onPressed: null, child: Text('Disabled')),
        ],
      ),
    );
    final go = only(items, (e) => e.testId == 'go');
    expect(go.kind, 'button');
    expect(go.text, 'Add one');
    expect(go.enabled, isTrue);
    expect(go.covered, isFalse);
    expect(go.frame.width, greaterThan(40));
    expect(only(items, (e) => e.testId == 'off').enabled, isFalse);
    // A button's label is the button's, not a paragraph of its own.
    expect(items.where((e) => e.kind == 'text' && e.text == 'Add one'), isEmpty);
    // Its inner InkWell and Semantics are the same control.
    expect(items.where((e) => e.kind == 'button'), hasLength(2));
  });

  testWidgets('gives a Text its key and an icon button its tooltip', (tester) async {
    final items = await screenOf(
      tester,
      Column(
        children: [
          const Text('Count: 2', key: ValueKey('count')),
          IconButton(onPressed: () {}, tooltip: 'Close', icon: const Icon(Icons.close)),
        ],
      ),
    );
    final count = only(items, (e) => e.testId == 'count');
    expect(count.kind, 'text');
    expect(count.text, 'Count: 2');
    expect(count.fontSize, 14);
    final close = only(items, (e) => e.kind == 'button');
    expect(close.accessibilityLabel, 'Close');
    expect(close.text, isNull, reason: 'the icon glyph is not text');
  });

  testWidgets('reads a text field: key, hint, label, value and focus', (tester) async {
    final controller = TextEditingController();
    final focus = FocusNode();
    final items = await screenOf(
      tester,
      Column(
        children: [
          TextField(
            key: const ValueKey('name'),
            controller: controller,
            focusNode: focus,
            decoration: const InputDecoration(labelText: 'Name', hintText: 'Your name', errorText: 'Required'),
          ),
          const TextField(key: ValueKey('secret'), obscureText: true),
        ],
      ),
    );
    var name = only(items, (e) => e.testId == 'name');
    expect(name.kind, 'input');
    expect(name.accessibilityLabel, 'Name');
    expect(name.value, isNull);
    expect(name.focused, isFalse);
    expect(items.where((e) => e.kind == 'text' && e.text == 'Required'), hasLength(1));
    expect(items.where((e) => e.text == 'Name' || e.text == 'Your name'), isEmpty);

    focus.requestFocus();
    controller.text = 'Ana';
    await tester.pumpAndSettle();
    name = only(takeSnapshot().elements, (e) => e.testId == 'name');
    expect(name.value, 'Ana');
    expect(name.focused, isTrue);

    await tester.enterText(find.byKey(const ValueKey('secret')), 'hunter2');
    final secret = only(takeSnapshot().elements, (e) => e.testId == 'secret');
    expect(secret.value, '•••••••');
  });

  testWidgets('a hint shows as the placeholder of an empty field', (tester) async {
    final items = await screenOf(
      tester,
      const TextField(
        key: ValueKey('q'),
        decoration: InputDecoration(hintText: 'Search'),
      ),
    );
    expect(only(items, (e) => e.testId == 'q').placeholder, 'Search');
  });

  testWidgets('lists a Cupertino button, switch and field without knowing their classes', (tester) async {
    final items = await screenOf(
      tester,
      Column(
        children: [
          CupertinoButton(key: const ValueKey('c'), onPressed: () {}, child: const Text('Continue')),
          const CupertinoButton(key: ValueKey('c-off'), onPressed: null, child: Text('Later')),
          CupertinoSwitch(key: const ValueKey('s'), value: true, onChanged: (_) {}),
          const CupertinoTextField(key: ValueKey('f'), placeholder: 'Email'),
        ],
      ),
    );
    final button = only(items, (e) => e.testId == 'c');
    expect(button.kind, 'button');
    expect(button.text, 'Continue');
    expect(only(items, (e) => e.testId == 'c-off').enabled, isFalse);
    expect(only(items, (e) => e.testId == 's').kind, 'switch');
    final field = only(items, (e) => e.testId == 'f');
    expect(field.kind, 'input');
    expect(field.placeholder, 'Email');
  });

  testWidgets('a tappable row holding its own button is not one button', (tester) async {
    final items = await screenOf(
      tester,
      ListTile(
        onTap: () {},
        title: const Text('Ana'),
        trailing: IconButton(key: const ValueKey('like'), onPressed: () {}, icon: const Icon(Icons.favorite)),
      ),
    );
    expect(only(items, (e) => e.testId == 'like').kind, 'button');
    final row = only(items, (e) => e.kind == 'button' && e.testId == null);
    expect(row.text, 'Ana');
  });

  testWidgets('a tap handler around a disabled icon button is the button a finger meets, enabled', (tester) async {
    var taps = 0;
    final items = await screenOf(
      tester,
      Center(
        child: InkWell(
          key: const ValueKey('cell'),
          onTap: () => taps++,
          excludeFromSemantics: true,
          child: const IconButton(onPressed: null, icon: Icon(Icons.check)),
        ),
      ),
    );
    final cell = only(items, (e) => e.testId == 'cell');
    expect(cell.kind, 'button');
    expect(cell.enabled, isTrue);
    await tester.tapAt(cell.frame.center);
    expect(taps, 1);
  });

  testWidgets('an open menu lists its items apart from the button that opened it, on top', (tester) async {
    // Cupertino-style menus put the OverlayPortal inside the button that opens them.
    final portal = OverlayPortalController();
    await screenOf(
      tester,
      Align(
        alignment: Alignment.topLeft,
        child: TextButton(
          onPressed: portal.show,
          child: OverlayPortal(
            controller: portal,
            overlayChildBuilder: (_) => Positioned(
              top: 100,
              left: 20,
              child: Column(
                children: [
                  TextButton(onPressed: () {}, child: const Text('By Status')),
                  TextButton(onPressed: () {}, child: const Text('Habit Type')),
                ],
              ),
            ),
            child: const Text('Filters'),
          ),
        ),
      ),
    );
    portal.show();
    await tester.pump();
    final items = takeSnapshot().elements;
    final anchor = only(items, (e) => e.kind == 'button' && (e.text ?? '').startsWith('Filters'));
    expect(anchor.text, 'Filters');
    final status = only(items, (e) => e.kind == 'button' && e.text == 'By Status');
    expect(status.frame.top, 100);
    expect(only(items, (e) => e.kind == 'button' && e.text == 'Habit Type').i, greaterThan(status.i));
    expect(status.i, greaterThan(anchor.i));
  });

  testWidgets('a paragraph of widget spans lists the paragraphs inside them', (tester) async {
    final items = await screenOf(
      tester,
      const Text.rich(
        TextSpan(
          children: [
            WidgetSpan(child: Text('Fix: show the window at startup')),
            TextSpan(text: ' and '),
            WidgetSpan(child: Text('Feature: Esperanto')),
          ],
        ),
      ),
    );
    final texts = items.where((e) => e.kind == 'text').map((e) => e.text).toList();
    expect(texts, containsAll(['Fix: show the window at startup', 'Feature: Esperanto']));
    final bare = await screenOf(tester, const Text.rich(WidgetSpan(child: Text('Only a widget'))));
    expect(bare.where((e) => e.kind == 'text').map((e) => e.text), ['Only a widget']);
  });

  testWidgets('lists only what is on screen: the top route, the visible rows', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListView.builder(
            key: const ValueKey('list'),
            itemCount: 100,
            itemBuilder: (context, i) => SizedBox(height: 50, child: Text('Item $i')),
          ),
        ),
      ),
    );
    var items = takeSnapshot().elements;
    expect(only(items, (e) => e.testId == 'list').kind, 'scroll');
    expect(items.where((e) => e.text == 'Item 0'), hasLength(1));
    expect(items.where((e) => e.text == 'Item 30'), isEmpty);
    final rows = items.where((e) => e.text?.startsWith('Item ') ?? false);
    expect(rows.every((e) => e.parent == items.firstWhere((s) => s.testId == 'list').i), isTrue);

    final navigator = tester.state<NavigatorState>(find.byType(Navigator));
    navigator.push(MaterialPageRoute<void>(builder: (_) => const Scaffold(body: Text('Second'))));
    await tester.pumpAndSettle();
    items = takeSnapshot().elements;
    expect(items.where((e) => e.text == 'Second'), hasLength(1));
    expect(items.where((e) => e.text == 'Item 0'), isEmpty);
  });

  testWidgets('a dialog hides the page under it and says it is presenting', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: ElevatedButton(
              key: const ValueKey('open'),
              onPressed: () => showDialog<void>(
                context: context,
                builder: (_) => AlertDialog(
                  key: const ValueKey('confirm'),
                  title: const Text('Delete everything?'),
                  actions: [TextButton(onPressed: () {}, child: const Text('Delete'))],
                ),
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const ValueKey('open')));
    await tester.pumpAndSettle();
    final snapshot = takeSnapshot();
    final items = snapshot.elements;
    expect(only(items, (e) => e.testId == 'open').hidden, 'behind-modal');
    expect(only(items, (e) => e.text == 'Delete').hidden, isNull);
    expect(only(items, (e) => e.text == 'Delete everything?').hidden, isNull);
    expect(snapshot.presenting?['modal'], isTrue);
    expect(snapshot.presenting?['testId'], 'confirm');
  });

  testWidgets('marks what is covered, inert or faded out', (tester) async {
    final items = await screenOf(
      tester,
      Column(
        children: [
          SizedBox(
            height: 60,
            child: Stack(
              children: [
                ElevatedButton(key: const ValueKey('under'), onPressed: () {}, child: const Text('Under')),
                const Positioned.fill(child: ColoredBox(color: Colors.red)),
              ],
            ),
          ),
          IgnorePointer(
            child: TextButton(key: const ValueKey('inert'), onPressed: () {}, child: const Text('Inert')),
          ),
          Opacity(
            opacity: 0,
            child: TextButton(key: const ValueKey('faded'), onPressed: () {}, child: const Text('Faded')),
          ),
        ],
      ),
    );
    expect(only(items, (e) => e.testId == 'under').covered, isTrue);
    expect(only(items, (e) => e.testId == 'inert').hidden, 'inert');
    expect(items.where((e) => e.testId == 'faded'), isEmpty);
  });

  testWidgets('a Semantics identifier is a test id', (tester) async {
    final items = await screenOf(
      tester,
      Semantics(
        identifier: 'banner',
        child: const SizedBox(width: 100, height: 40, child: ColoredBox(color: Colors.blue)),
      ),
    );
    expect(only(items, (e) => e.testId == 'banner').kind, 'view');
  });

  testWidgets('inert is what the render object does, not what the widget last said', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: IgnorePointer(
            ignoring: false,
            child: TextButton(key: const ValueKey('go'), onPressed: () {}, child: const Text('Go')),
          ),
        ),
      ),
    );
    final render = tester.renderObject<RenderIgnorePointer>(
      find.ancestor(of: find.byKey(const ValueKey('go')), matching: find.byType(IgnorePointer)).first,
    );
    // What a Scrollable does to its IgnorePointer during a fling: the render object changes, the widget does not.
    render.ignoring = true;
    expect(only(takeSnapshot().elements, (e) => e.testId == 'go').hidden, 'inert');
    render.ignoring = false;
    expect(only(takeSnapshot().elements, (e) => e.testId == 'go').hidden, isNull);
  });

  testWidgets('a list that has stopped scrolling takes touches again', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListView(
            children: [
              for (var i = 0; i < 40; i++) TextButton(key: ValueKey('row-$i'), onPressed: () {}, child: Text('Row $i')),
            ],
          ),
        ),
      ),
    );
    await tester.fling(find.byType(ListView), const Offset(0, -300), 1000);
    await tester.pump(const Duration(milliseconds: 50));
    expect(takeSnapshot().elements.where((e) => e.kind == 'button').every((e) => e.hidden == 'inert'), isTrue);
    await tester.pumpAndSettle();
    expect(takeSnapshot().elements.where((e) => e.kind == 'button').every((e) => e.hidden == null), isTrue);
  });

  for (final made in [true, false]) {
    testWidgets('a native view is reported with its type and rectangle, ${made ? 'made' : 'refused, as on a host'}', (
      tester,
    ) async {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform_views, (call) async {
        if (call.method == 'create' && !made) throw PlatformException(code: 'unsupported');
        return null;
      });
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform_views, null),
      );
      await tester.pumpWidget(
        const Directionality(
          textDirection: TextDirection.ltr,
          child: Column(
            children: [
              SizedBox(height: 100),
              SizedBox(width: 300, height: 80, child: UiKitView(viewType: 'tab_bar')),
            ],
          ),
        ),
      );
      await tester.pump();
      if (!made) tester.takeException();
      expect(platformViews(), [
        {
          'viewType': 'tab_bar',
          'frame': {'x': 250.0, 'y': 100.0, 'w': 300.0, 'h': 80.0},
        },
      ]);
    });
  }
}
