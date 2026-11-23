import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

/*
 * The few calls of SQLite's C API a host needs to stand in for sqflite's native side, bound with dart:ffi to the
 * system's library (every Mac and the Linux images the hosts run on have it). Our own bindings rather than
 * package:sqlite3, whose build hooks would add a native asset to every app that depends on the agent.
 */

const _ok = 0;
const _row = 100;
const _done = 101;
const _openReadOnly = 0x01;
const _openReadWrite = 0x02;
const _openCreate = 0x04;
const _integer = 1;
const _float = 2;
const _text = 3;
const _blob = 4;

typedef _OpenC = Int32 Function(Pointer<Uint8>, Pointer<Pointer<Void>>, Int32, Pointer<Void>);
typedef _Open = int Function(Pointer<Uint8>, Pointer<Pointer<Void>>, int, Pointer<Void>);
typedef _PrepareC =
    Int32 Function(Pointer<Void>, Pointer<Uint8>, Int32, Pointer<Pointer<Void>>, Pointer<Pointer<Uint8>>);
typedef _Prepare = int Function(Pointer<Void>, Pointer<Uint8>, int, Pointer<Pointer<Void>>, Pointer<Pointer<Uint8>>);

final class _Api {
  _Api(DynamicLibrary lib)
    : open = lib.lookupFunction<_OpenC, _Open>('sqlite3_open_v2'),
      close = lib.lookupFunction<Int32 Function(Pointer<Void>), int Function(Pointer<Void>)>('sqlite3_close_v2'),
      prepare = lib.lookupFunction<_PrepareC, _Prepare>('sqlite3_prepare_v2'),
      step = lib.lookupFunction<Int32 Function(Pointer<Void>), int Function(Pointer<Void>)>('sqlite3_step'),
      finalize = lib.lookupFunction<Int32 Function(Pointer<Void>), int Function(Pointer<Void>)>('sqlite3_finalize'),
      bindNull = lib.lookupFunction<Int32 Function(Pointer<Void>, Int32), int Function(Pointer<Void>, int)>(
        'sqlite3_bind_null',
      ),
      bindInt = lib.lookupFunction<Int32 Function(Pointer<Void>, Int32, Int64), int Function(Pointer<Void>, int, int)>(
        'sqlite3_bind_int64',
      ),
      bindDouble = lib
          .lookupFunction<Int32 Function(Pointer<Void>, Int32, Double), int Function(Pointer<Void>, int, double)>(
            'sqlite3_bind_double',
          ),
      bindText = lib
          .lookupFunction<
            Int32 Function(Pointer<Void>, Int32, Pointer<Uint8>, Int32, IntPtr),
            int Function(Pointer<Void>, int, Pointer<Uint8>, int, int)
          >('sqlite3_bind_text'),
      bindBlob = lib
          .lookupFunction<
            Int32 Function(Pointer<Void>, Int32, Pointer<Uint8>, Int32, IntPtr),
            int Function(Pointer<Void>, int, Pointer<Uint8>, int, int)
          >('sqlite3_bind_blob'),
      columnCount = lib.lookupFunction<Int32 Function(Pointer<Void>), int Function(Pointer<Void>)>(
        'sqlite3_column_count',
      ),
      columnName = lib
          .lookupFunction<Pointer<Uint8> Function(Pointer<Void>, Int32), Pointer<Uint8> Function(Pointer<Void>, int)>(
            'sqlite3_column_name',
          ),
      columnType = lib.lookupFunction<Int32 Function(Pointer<Void>, Int32), int Function(Pointer<Void>, int)>(
        'sqlite3_column_type',
      ),
      columnInt = lib.lookupFunction<Int64 Function(Pointer<Void>, Int32), int Function(Pointer<Void>, int)>(
        'sqlite3_column_int64',
      ),
      columnDouble = lib.lookupFunction<Double Function(Pointer<Void>, Int32), double Function(Pointer<Void>, int)>(
        'sqlite3_column_double',
      ),
      columnText = lib
          .lookupFunction<Pointer<Uint8> Function(Pointer<Void>, Int32), Pointer<Uint8> Function(Pointer<Void>, int)>(
            'sqlite3_column_text',
          ),
      columnBlob = lib
          .lookupFunction<Pointer<Uint8> Function(Pointer<Void>, Int32), Pointer<Uint8> Function(Pointer<Void>, int)>(
            'sqlite3_column_blob',
          ),
      columnBytes = lib.lookupFunction<Int32 Function(Pointer<Void>, Int32), int Function(Pointer<Void>, int)>(
        'sqlite3_column_bytes',
      ),
      changes = lib.lookupFunction<Int32 Function(Pointer<Void>), int Function(Pointer<Void>)>('sqlite3_changes'),
      lastInsertRowId = lib.lookupFunction<Int64 Function(Pointer<Void>), int Function(Pointer<Void>)>(
        'sqlite3_last_insert_rowid',
      ),
      errmsg = lib.lookupFunction<Pointer<Uint8> Function(Pointer<Void>), Pointer<Uint8> Function(Pointer<Void>)>(
        'sqlite3_errmsg',
      ),
      extendedErrcode = lib.lookupFunction<Int32 Function(Pointer<Void>), int Function(Pointer<Void>)>(
        'sqlite3_extended_errcode',
      ),
      autocommit = lib.lookupFunction<Int32 Function(Pointer<Void>), int Function(Pointer<Void>)>(
        'sqlite3_get_autocommit',
      );

  final _Open open;
  final int Function(Pointer<Void>) close;
  final _Prepare prepare;
  final int Function(Pointer<Void>) step;
  final int Function(Pointer<Void>) finalize;
  final int Function(Pointer<Void>, int) bindNull;
  final int Function(Pointer<Void>, int, int) bindInt;
  final int Function(Pointer<Void>, int, double) bindDouble;
  final int Function(Pointer<Void>, int, Pointer<Uint8>, int, int) bindText;
  final int Function(Pointer<Void>, int, Pointer<Uint8>, int, int) bindBlob;
  final int Function(Pointer<Void>) columnCount;
  final Pointer<Uint8> Function(Pointer<Void>, int) columnName;
  final int Function(Pointer<Void>, int) columnType;
  final int Function(Pointer<Void>, int) columnInt;
  final double Function(Pointer<Void>, int) columnDouble;
  final Pointer<Uint8> Function(Pointer<Void>, int) columnText;
  final Pointer<Uint8> Function(Pointer<Void>, int) columnBlob;
  final int Function(Pointer<Void>, int) columnBytes;
  final int Function(Pointer<Void>) changes;
  final int Function(Pointer<Void>) lastInsertRowId;
  final Pointer<Uint8> Function(Pointer<Void>) errmsg;
  final int Function(Pointer<Void>) extendedErrcode;
  final int Function(Pointer<Void>) autocommit;
}

final class _Memory {
  static final _libc = DynamicLibrary.process();
  static final malloc = _libc.lookupFunction<Pointer<Void> Function(IntPtr), Pointer<Void> Function(int)>('malloc');
  static final free = _libc.lookupFunction<Void Function(Pointer<Void>), void Function(Pointer<Void>)>('free');

  static Pointer<Uint8> bytes(List<int> data, {bool terminate = false}) {
    final p = malloc(data.length + (terminate ? 1 : 0) + 1).cast<Uint8>();
    p.asTypedList(data.length).setAll(0, data);
    if (terminate) p[data.length] = 0;
    return p;
  }

  static Pointer<Pointer<T>> pointer<T extends NativeType>() {
    final p = malloc(sizeOf<IntPtr>()).cast<Pointer<T>>();
    p.value = nullptr;
    return p;
  }
}

String _string(Pointer<Uint8> p) {
  if (p == nullptr) return '';
  var n = 0;
  while (p[n] != 0) {
    n++;
  }
  return utf8.decode(p.asTypedList(n));
}

/// An error SQLite reported, with its extended result code.
class SqliteException implements Exception {
  SqliteException(this.message, this.code);
  final String message;
  final int code;
  @override
  String toString() => message;
}

/// What a statement gave back: its rows, and the changes and row id it left on the connection.
typedef SqliteResult = ({List<String> columns, List<List<Object?>> rows, int changes, int lastInsertRowId});

/// The system's SQLite, or null where it cannot be loaded.
class Sqlite {
  Sqlite._(this._api);

  static Sqlite? _loaded;
  static Object? loadError;

  static Sqlite? load() {
    if (_loaded != null || loadError != null) return _loaded;
    final candidates = Platform.isMacOS || Platform.isIOS
        ? ['/usr/lib/libsqlite3.dylib', 'libsqlite3.dylib']
        : ['libsqlite3.so.0', 'libsqlite3.so'];
    for (final name in candidates) {
      try {
        return _loaded = Sqlite._(_Api(DynamicLibrary.open(name)));
      } on Object catch (error) {
        loadError = error;
      }
    }
    return null;
  }

  final _Api _api;

  SqliteDatabase open(String path, {bool readOnly = false}) {
    final handle = _Memory.pointer<Void>();
    final name = _Memory.bytes(utf8.encode(path), terminate: true);
    try {
      final flags = readOnly ? _openReadOnly : _openReadWrite | _openCreate;
      final rc = _api.open(name, handle, flags, nullptr);
      final db = handle.value;
      if (rc != _ok) {
        final message = db == nullptr ? 'out of memory' : _string(_api.errmsg(db));
        if (db != nullptr) _api.close(db);
        throw SqliteException('open failed: $message ($path)', rc);
      }
      return SqliteDatabase._(_api, db);
    } finally {
      _Memory.free(name.cast());
      _Memory.free(handle.cast());
    }
  }
}

/// One open connection.
class SqliteDatabase {
  SqliteDatabase._(this._api, this._db);

  final _Api _api;
  Pointer<Void> _db;

  bool get inTransaction => _db != nullptr && _api.autocommit(_db) == 0;

  void close() {
    if (_db == nullptr) return;
    _api.close(_db);
    _db = nullptr;
  }

  SqliteException _error(int rc) => SqliteException(_string(_api.errmsg(_db)), _api.extendedErrcode(_db));

  /// Runs every statement in [sql] (arguments go to the first), and returns the rows of the last one that has any.
  SqliteResult run(String sql, [List<Object?> arguments = const []]) {
    if (_db == nullptr) throw SqliteException('database_closed', 0);
    final source = utf8.encode(sql);
    final start = _Memory.bytes(source, terminate: true);
    final statement = _Memory.pointer<Void>();
    final tail = _Memory.pointer<Uint8>();
    var columns = <String>[];
    var rows = <List<Object?>>[];
    var first = true;
    try {
      var at = start;
      while (true) {
        final rc = _api.prepare(_db, at, -1, statement, tail);
        if (rc != _ok) throw _error(rc);
        final stmt = statement.value;
        at = tail.value;
        if (stmt == nullptr) {
          if (at == nullptr || at[0] == 0) break;
          continue;
        }
        final allocated = <Pointer<Void>>[];
        try {
          if (first) {
            for (var i = 0; i < arguments.length; i++) {
              _bind(stmt, i + 1, arguments[i], allocated);
            }
            first = false;
          }
          final count = _api.columnCount(stmt);
          final names = [for (var i = 0; i < count; i++) _string(_api.columnName(stmt, i))];
          final got = <List<Object?>>[];
          while (true) {
            final s = _api.step(stmt);
            if (s == _done) break;
            if (s != _row) throw _error(s);
            got.add([for (var i = 0; i < count; i++) _column(stmt, i)]);
          }
          if (count > 0) {
            columns = names;
            rows = got;
          }
        } finally {
          _api.finalize(stmt);
          for (final p in allocated) {
            _Memory.free(p);
          }
        }
        if (at == nullptr || at[0] == 0) break;
      }
      return (columns: columns, rows: rows, changes: _api.changes(_db), lastInsertRowId: _api.lastInsertRowId(_db));
    } finally {
      _Memory.free(start.cast());
      _Memory.free(statement.cast());
      _Memory.free(tail.cast());
    }
  }

  // SQLITE_TRANSIENT: SQLite copies the value, so it is freed once the statement is done.
  static const _transient = -1;

  void _bind(Pointer<Void> stmt, int index, Object? value, List<Pointer<Void>> allocated) {
    final int rc;
    switch (value) {
      case null:
        rc = _api.bindNull(stmt, index);
      case bool():
        rc = _api.bindInt(stmt, index, value ? 1 : 0);
      case int():
        rc = _api.bindInt(stmt, index, value);
      case double():
        rc = _api.bindDouble(stmt, index, value);
      case String():
        final bytes = utf8.encode(value);
        final p = _Memory.bytes(bytes);
        allocated.add(p.cast());
        rc = _api.bindText(stmt, index, p, bytes.length, _transient);
      case List<int>():
        final p = _Memory.bytes(value);
        allocated.add(p.cast());
        rc = _api.bindBlob(stmt, index, p, value.length, _transient);
      default:
        throw SqliteException('Invalid argument $value (${value.runtimeType})', 0);
    }
    if (rc != _ok) throw _error(rc);
  }

  Object? _column(Pointer<Void> stmt, int i) => switch (_api.columnType(stmt, i)) {
    _integer => _api.columnInt(stmt, i),
    _float => _api.columnDouble(stmt, i),
    _text => utf8.decode(_api.columnText(stmt, i).asTypedList(_api.columnBytes(stmt, i))),
    _blob => Uint8List.fromList(_api.columnBlob(stmt, i).asTypedList(_api.columnBytes(stmt, i))),
    _ => null,
  };
}
