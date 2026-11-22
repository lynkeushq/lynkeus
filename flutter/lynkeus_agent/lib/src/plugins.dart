import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';

import 'sqlite.dart';
import 'standins.dart';

/*
 * The common plugins' native sides, from memory. Under `flutter test` no platform registers its implementation, so
 * each plugin falls back to its platform interface's default: a method channel with the names below (the same ones
 * the plugins' own unit tests mock). A Pigeon implementation registered by the app itself is answered the same way.
 */

/// What the stand-ins hold for a run, and what a driver's commands read and set.
class PluginState {
  PluginState(this.folder);

  /// path_provider's folders live here: a temporary folder per run.
  final Directory folder;
  final preferences = <String, Object?>{};
  final secure = <String, String>{};
  final launched = <String>[];

  /// The sensor local_auth sees: what is enrolled, and how the next prompts end.
  var biometrics = <String>['face'];
  final outcomes = <String>[];

  /// permission_handler's statuses by permission number; anything not set is granted.
  final permissions = <int, int>{};
  var online = true;
  final _connectivityListeners = <void Function()>[];

  /// sqflite's open databases by the id the app holds.
  final _databases = <int, ({String path, SqliteDatabase db})>{};
  var _nextDatabase = 0;
  var _nextTransaction = 0;

  void reset() {
    for (final open in _databases.values) {
      open.db.close();
    }
    _databases.clear();
    final databases = Directory('${folder.path}/databases');
    if (databases.existsSync()) databases.deleteSync(recursive: true);
    preferences.clear();
    secure.clear();
    launched.clear();
    outcomes.clear();
  }
}

String _folder(PluginState state, String name) {
  final dir = Directory('${state.folder.path}/$name')..createSync(recursive: true);
  return dir.path;
}

Map<Object?, Object?> _argMap(List<Object?> args) =>
    args.isNotEmpty && args.first is Map ? args.first! as Map : const {};

/// Puts every stand-in on [standIns] and the commands that drive them on [register].
void installPlugins(
  StandIns standIns,
  PluginState state,
  void Function(String name, FutureOr<Object?> Function(Object? params) handler) register,
  Future<void> Function(String channel, ByteData? message) fromPlatform,
  String platform,
) {
  // shared_preferences keeps keys with the `flutter.` prefix it adds itself.
  standIns.add('plugins.flutter.io/shared_preferences', (method, args) {
    final a = _argMap(args);
    final prefix = a['prefix'] as String? ?? 'flutter.';
    final allow = (a['allowList'] as List<Object?>?)?.toSet();
    bool chosen(String key) => key.startsWith(prefix) && (allow == null || allow.contains(key));
    switch (method) {
      case 'getAll':
      case 'getAllWithPrefix':
      case 'getAllWithParameters':
        return {
          for (final e in state.preferences.entries)
            if (method == 'getAll' ? e.key.startsWith('flutter.') : chosen(e.key)) e.key: e.value,
        };
      case 'setBool' || 'setInt' || 'setDouble' || 'setString' || 'setStringList':
        state.preferences[a['key']! as String] = a['value'];
        return true;
      case 'remove':
        state.preferences.remove(a['key']);
        return true;
      case 'clear' || 'clearWithPrefix' || 'clearWithParameters':
        state.preferences.removeWhere((key, _) => method == 'clear' ? key.startsWith('flutter.') : chosen(key));
        return true;
    }
    return null;
  });

  standIns.add('plugins.it_nomads.com/flutter_secure_storage', (method, args) {
    final a = _argMap(args);
    final key = a['key'] as String?;
    return switch (method) {
      'write' => state.secure[key!] = a['value']! as String,
      'read' => state.secure[key],
      'readAll' => Map.of(state.secure),
      'containsKey' => state.secure.containsKey(key),
      'delete' => state.secure.remove(key),
      'deleteAll' => state.secure.clear(),
      _ => null,
    };
  });

  standIns.add('plugins.flutter.io/path_provider', (method, args) {
    return switch (method) {
      'getTemporaryDirectory' => _folder(state, 'tmp'),
      'getApplicationSupportDirectory' => _folder(state, 'support'),
      'getApplicationDocumentsDirectory' => _folder(state, 'documents'),
      'getApplicationCacheDirectory' => _folder(state, 'cache'),
      'getLibraryDirectory' => _folder(state, 'library'),
      'getDownloadsDirectory' => _folder(state, 'downloads'),
      'getExternalStorageDirectory' => _folder(state, 'external'),
      'getExternalCacheDirectories' || 'getExternalStorageDirectories' => [_folder(state, 'external')],
      _ => null,
    };
  });

  standIns.add('dev.fluttercommunity.plus/device_info', (method, args) {
    if (method != 'getDeviceInfo') return null;
    if (platform == 'android') {
      return {
        'version': {
          'sdkInt': 35,
          'release': '15',
          'codename': 'REL',
          'incremental': '1',
          'securityPatch': '2026-11-01',
          'baseOS': '',
          'previewSdkInt': 0,
        },
        'board': 'goldfish_arm64',
        'bootloader': 'unknown',
        'brand': 'google',
        'device': 'emu64a',
        'display': 'lynkeus', //
        'fingerprint': 'lynkeus/headless',
        'hardware': 'ranchu',
        'host': 'lynkeus',
        'id': 'LYNKEUS',
        'manufacturer': 'Google',
        'model': 'sdk_gphone64_arm64',
        'product': 'sdk_gphone64_arm64',
        'name': 'Lynkeus headless',
        'supported32BitAbis': <String>[],
        'supported64BitAbis': ['arm64-v8a'], 'supportedAbis': ['arm64-v8a'], 'tags': 'release-keys', 'type': 'user',
        'isPhysicalDevice': false, 'systemFeatures': <String>[], 'serialNumber': 'unknown', 'isLowRamDevice': false,
        'physicalRamSize': 4096, 'availableRamSize': 2048,
      };
    }
    return {
      'name': 'iPhone 17', 'systemName': 'iOS', 'systemVersion': '26.5', 'model': 'iPhone', 'modelName': 'iPhone 17', //
      'localizedModel': 'iPhone',
      'identifierForVendor': '00000000-0000-0000-0000-000000000000',
      'isPhysicalDevice': false,
      'isiOSAppOnMac': false, 'physicalRamSize': 8192, 'availableRamSize': 4096,
      'utsname': {
        'sysname': 'Darwin',
        'nodename': 'lynkeus',
        'release': '25.0.0',
        'version': 'Darwin',
        'machine': 'arm64',
      },
    };
  });

  standIns.add('dev.fluttercommunity.plus/package_info', (method, args) {
    if (method != 'getAll') return null;
    return {
      'appName': 'lynkeus host',
      'packageName': 'io.lynkeus.host',
      'version': '1.0.0',
      'buildNumber': '1',
      'buildSignature': '',
      'installerStore': null,
    };
  });

  // An opened URL is written down for the driver; nothing leaves the host.
  standIns.add('plugins.flutter.io/url_launcher', (method, args) {
    final url = _argMap(args)['url'] as String?;
    switch (method) {
      case 'canLaunch':
        return url != null;
      case 'launch':
        if (url != null) state.launched.add(url);
        return true;
    }
    return null;
  });

  standIns.add('plugins.flutter.io/local_auth', (method, args) {
    switch (method) {
      case 'isDeviceSupported' || 'deviceSupportsBiometrics':
        return state.biometrics.isNotEmpty;
      case 'getAvailableBiometrics' || 'getEnrolledBiometrics':
        return state.biometrics;
      case 'stopAuthentication':
        return true;
      case 'authenticate':
        final next = state.outcomes.isEmpty ? 'success' : state.outcomes.removeAt(0);
        if (next == 'success') return true;
        if (next == 'fail' || next == 'cancel') return false;
        throw PlatformException(code: next, message: 'lynkeus: the biometrics command said $next');
    }
    return null;
  });

  // permission_handler numbers its statuses: 0 denied, 1 granted, 2 restricted, 3 limited, 4 permanently denied.
  standIns.add('flutter.baseflow.com/permissions/methods', (method, args) {
    final first = args.isEmpty ? null : args.first;
    switch (method) {
      case 'checkPermissionStatus':
        return state.permissions[first] ?? 1;
      case 'checkServiceStatus':
        return 1;
      case 'requestPermissions':
        // A list of arguments arrives as the arguments themselves.
        return {for (final p in args) p: state.permissions[p] ?? 1};
      case 'shouldShowRequestPermissionRationale':
        return false;
      case 'openAppSettings':
        return true;
    }
    return null;
  });

  List<String> connectivity() => state.online ? ['wifi'] : ['none'];
  const statusChannel = 'dev.fluttercommunity.plus/connectivity_status';
  void emitConnectivity() =>
      unawaited(fromPlatform(statusChannel, const StandardMethodCodec().encodeSuccessEnvelope(connectivity())));
  standIns.add('dev.fluttercommunity.plus/connectivity', (method, args) => method == 'check' ? connectivity() : null);
  standIns.add(statusChannel, (method, args) {
    if (method == 'listen') {
      state._connectivityListeners.add(emitConnectivity);
      scheduleMicrotask(emitConnectivity);
    } else if (method == 'cancel') {
      state._connectivityListeners.clear();
    }
    return null;
  });

  _installSqflite(standIns, state);

  register('launched', (params) {
    final urls = List.of(state.launched);
    if (params is Map && params['clear'] == true) state.launched.clear();
    return {'urls': urls};
  });
  register('biometrics', (params) {
    final p = params is Map ? params : const {};
    final available = p['available'];
    if (available != null) state.biometrics = available == 'none' ? [] : ['$available'.toLowerCase()];
    final next = p['next'];
    if (next is String) state.outcomes.add(next);
    if (next is List) state.outcomes.addAll(next.map((e) => '$e'));
    return {'available': state.biometrics, 'next': state.outcomes};
  });
  register('permissions', (params) {
    final p = params is Map ? params : const {};
    for (final e in p.entries) {
      final number = int.tryParse('${e.key}');
      if (number != null && e.value is num) state.permissions[number] = (e.value as num).toInt();
    }
    return {
      'permissions': {for (final e in state.permissions.entries) '${e.key}': e.value},
    };
  });
  register('network', (params) {
    final wanted = params is Map ? params['state'] : null;
    if (wanted != 'on' && wanted != 'off') throw ArgumentError('network needs { state: "on" | "off" }');
    state.online = wanted == 'on';
    for (final listener in List.of(state._connectivityListeners)) {
      listener();
    }
    return {'online': state.online};
  });
}

/*
 * sqflite's native side: the method channel `com.tekartik.sqflite` that sqflite_common speaks (openDatabase,
 * execute, insert, update, query, batch, ...), answered by the system's SQLite. Databases live in a folder of the
 * run. sqflite 2.4 reaches this channel under a host only once its factory is set (package lynkeus_plugins).
 */
void _installSqflite(StandIns standIns, PluginState state) {
  String databasesPath() => _folder(state, 'databases');

  ({String path, SqliteDatabase db}) open(Map<Object?, Object?> a) {
    final id = a['id'];
    final found = state._databases[id];
    if (found == null) throw PlatformException(code: 'sqlite_error', message: 'database_closed $id');
    return found;
  }

  PlatformException failure(SqliteException error, String? sql, Object? arguments) => PlatformException(
    code: 'sqlite_error',
    message: '${error.message} (code ${error.code})',
    details: {'sql': ?sql, 'arguments': ?arguments},
  );

  Object? run(String method, Map<Object?, Object?> a) {
    final sql = a['sql'] as String?;
    final arguments = (a['arguments'] as List<Object?>?) ?? const [];
    final db = open(a).db;
    try {
      final result = db.run(sql ?? '', arguments);
      return switch (method) {
        'execute' => a['inTransaction'] == true ? {'transactionId': ++state._nextTransaction} : null,
        'insert' => result.changes == 0 ? null : result.lastInsertRowId,
        'update' => result.changes,
        'query' => {'columns': result.columns, 'rows': result.rows},
        _ => throw PlatformException(code: 'sqlite_error', message: 'unknown batch method $method'),
      };
    } on SqliteException catch (error) {
      throw failure(error, sql, arguments);
    }
  }

  standIns.add('com.tekartik.sqflite', (method, args) {
    final a = _argMap(args);
    switch (method) {
      case 'getPlatformVersion':
        return 'Lynkeus host';
      case 'getDatabasesPath':
        return databasesPath();
      case 'options':
      case 'debugMode':
        return null;
      case 'databaseExists':
        return File('${a['path']}').existsSync();
      case 'deleteDatabase':
        final path = '${a['path']}';
        state._databases.removeWhere((_, open) {
          if (open.path != path) return false;
          open.db.close();
          return true;
        });
        for (final suffix in const ['', '-journal', '-wal', '-shm']) {
          final file = File('$path$suffix');
          if (file.existsSync()) file.deleteSync();
        }
        return null;
      case 'openDatabase':
        final path = '${a['path']}';
        if (a['singleInstance'] == true) {
          for (final entry in state._databases.entries) {
            if (entry.value.path == path) {
              return {'id': entry.key, 'recovered': true, 'recoveredInTransaction': entry.value.db.inTransaction};
            }
          }
        }
        final sqlite = Sqlite.load();
        if (sqlite == null) {
          throw PlatformException(
            code: 'sqlite_error',
            message: 'lynkeus: this host has no system SQLite (libsqlite3): ${Sqlite.loadError}',
          );
        }
        if (path != ':memory:') Directory(File(path).parent.path).createSync(recursive: true);
        try {
          final db = sqlite.open(path, readOnly: a['readOnly'] == true);
          final id = ++state._nextDatabase;
          state._databases[id] = (path: path, db: db);
          return {'id': id};
        } on SqliteException catch (error) {
          throw failure(error, null, null);
        }
      case 'closeDatabase':
        state._databases.remove(a['id'])?.db.close();
        return null;
      case 'execute':
      case 'insert':
      case 'update':
      case 'query':
        return run(method, a);
      case 'batch':
        final results = <Object?>[];
        final continueOnError = a['continueOnError'] == true;
        for (final operation in (a['operations'] as List<Object?>?) ?? const []) {
          final op = {...a, ...operation! as Map<Object?, Object?>};
          try {
            results.add({'result': run('${op['method']}', op)});
          } on PlatformException catch (error) {
            if (!continueOnError) rethrow;
            results.add({
              'error': {'code': error.code, 'message': error.message, 'data': error.details},
            });
          }
        }
        return a['noResult'] == true ? const <Object?>[] : results;
    }
    throw PlatformException(code: 'sqlite_error', message: 'lynkeus: sqflite method $method is not stood in for');
  });
}
