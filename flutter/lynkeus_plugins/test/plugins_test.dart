import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_agent/hosts.dart';
import 'package:lynkeus_agent/lynkeus_agent.dart';
import 'package:lynkeus_plugins/lynkeus_plugins.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_async_platform_interface.dart';
import 'package:sqflite_common/sqflite.dart';

void main() {
  // In order: the first test runs before anything is set, as on a device.
  testWidgets('does nothing off a host: the plugins keep what their registrant set', (tester) async {
    LynkeusAgent.debugStandingIn = false;
    LynkeusPlugins.ensureInitialized();
    expect(databaseFactoryOrNull, isNull);
    expect(SharedPreferencesAsyncPlatform.instance, isNull);
  });

  group('on a host', () {
    late PluginState state;

    setUp(() {
      final standIns = StandIns(log: (_) {});
      final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.allMessagesHandler = (channel, mock, message) =>
          StandIns.handles(channel) ? standIns.answer(channel, message) : messenger.delegate.send(channel, message);
      state = PluginState(Directory.systemTemp.createTempSync('lynkeus-plugins-test'));
      installPlugins(standIns, state, (_, _) {}, (_, _) async {}, 'ios');
      LynkeusAgent.debugStandingIn = true;
      LynkeusPlugins.ensureInitialized();
    });

    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.allMessagesHandler = null;
      state.reset();
    });

    testWidgets('sqflite opens a database in the run\'s folder and keeps what is written', (tester) async {
      await tester.runAsync(() async {
        final db = await openDatabase(
          'notes.db',
          version: 2,
          onCreate: (db, version) => db.execute('CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)'),
        );
        expect(db.path, startsWith(state.folder.path));
        expect(await db.getVersion(), 2);
        final id = await db.insert('notes', {'text': 'first'});
        await db.transaction((txn) async {
          await txn.insert('notes', {'text': 'second'});
          await txn.update('notes', {'text': 'one'}, where: 'id = ?', whereArgs: [id]);
        });
        final batch = db.batch()
          ..insert('notes', {'text': 'third'})
          ..delete('notes', where: 'text = ?', whereArgs: ['second']);
        expect(await batch.commit(), [3, 1]);
        expect(await db.query('notes', orderBy: 'id'), [
          {'id': 1, 'text': 'one'},
          {'id': 3, 'text': 'third'},
        ]);
        await expectLater(db.insert('notes', {'text': null}), throwsA(isA<DatabaseException>()));
        await expectLater(
          db.transaction((txn) async {
            await txn.insert('notes', {'text': 'lost'});
            throw StateError('rolled back');
          }),
          throwsStateError,
        );
        expect((await db.rawQuery('SELECT COUNT(*) AS n FROM notes')).single['n'], 2);
        await db.close();
        expect(await databaseExists(db.path), isTrue);
        await deleteDatabase(db.path);
        expect(await databaseExists(db.path), isFalse);
      });
    });

    testWidgets('SharedPreferencesAsync and SharedPreferencesWithCache keep values for the run', (tester) async {
      final prefs = SharedPreferencesAsync();
      await prefs.setString('name', 'Ana');
      await prefs.setStringList('tags', ['a', 'b']);
      expect(await prefs.getString('name'), 'Ana');
      expect(await prefs.getKeys(), {'name', 'tags'});
      final cached = await SharedPreferencesWithCache.create(
        cacheOptions: const SharedPreferencesWithCacheOptions(allowList: {'name', 'seen'}),
      );
      expect(cached.getString('name'), 'Ana');
      await cached.setBool('seen', true);
      expect(await prefs.getBool('seen'), isTrue);
      await prefs.clear();
      expect(await prefs.getKeys(), isEmpty);
    });

    test('says which plugins it covers', () {
      expect(LynkeusPlugins.covered, containsAll(['sqflite', 'shared_preferences (async)']));
    });
  });
}
