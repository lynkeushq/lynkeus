import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:clock/clock.dart';

import 'fence.dart';
import 'netcache.dart';
import 'redact.dart';

/*
 * Every request the app makes through dart:io's HttpClient (package:http's IOClient and dio's default adapter both
 * do) is recorded for `requests` and `trace`, counted in flight for `idle`, and checked against the driver's
 * `netmock` rules first: a rule answers instead of the server, a hold keeps the request where it is until released,
 * and `lost` lets the request reach the server and loses its answer. A port of packages/agent/src/requests.ts and
 * netmock.ts onto HttpOverrides.
 */

/// Set on an answer a mock gave instead of the server, by a layer below the app the agent cannot see into.
const mockedHeader = 'x-lynkeus-mocked';
const _keep = 200;
const _most = 16000;

int _ms() => clock.now().millisecondsSinceEpoch;

class _Rule {
  _Rule({
    required this.method,
    required this.path,
    required this.status,
    this.body,
    this.headers,
    this.delayMs,
    this.times,
    this.lost = false,
    this.bytes,
    this.replayed = false,
  });
  final String method;
  final String path;
  final int status;
  final String? body;
  final Map<String, String>? headers;
  final int? delayMs;
  final int? times;
  final bool lost;
  int hits = 0;

  /// A recorded body, answered as it was (a replayed fetch); a netmock rule's body is text.
  final List<int>? bytes;
  final bool replayed;

  Map<String, Object?> toJson() => {
    'method': method,
    'path': path,
    'status': status,
    'body': ?body,
    'headers': ?headers,
    'delayMs': ?delayMs,
    'times': ?times,
    'hits': hits,
    if (lost) 'lost': true,
  };
}

class _Hold {
  _Hold(this.method, this.path, this.times);
  final String method;
  final String path;
  final int? times;
  int hits = 0;
  Map<String, Object?> toJson() => {'method': method, 'path': path, 'times': ?times, 'hits': hits};
}

class _Held {
  _Held(this.method, this.path, this.go) : since = _ms();
  final String method;
  final String path;
  final int since;
  final Completer<void> go;
}

String _pathOf(Uri url) => url.hasQuery ? '${url.path}?${url.query}' : url.path;

bool _matches(String ruleMethod, String rulePath, String method, String path) =>
    (ruleMethod == '*' || ruleMethod == method) &&
    (rulePath.startsWith('^') ? RegExp(rulePath).hasMatch(path) : path.contains(rulePath));

/// One request as the protocol's `RequestRecord`.
class _Record {
  _Record(this.id, this.method, this.url) : startedAt = _ms();
  final int id;
  final String method;
  final String url;
  final int startedAt;
  int? status;
  int? ms;
  String? error;
  bool mocked = false;
  bool replayed = false;
  bool answeredHere = false;
  bool finished = false;
  Map<String, Object?>? request;
  Map<String, Object?>? response;

  Map<String, Object?> toJson() => {
    'id': id,
    'method': method,
    'url': url,
    'status': ?status,
    'startedAt': startedAt,
    'ms': ?ms,
    'error': ?error,
    if (mocked) 'mocked': true,
    if (replayed) 'replayed': true,
    'request': ?request,
    'response': ?response,
  };
}

// A picture or any other binary body is told by its size and type: as text it is noise, and the redaction, made for
// text, fails on it.
String _shown(Map<String, String> headers, List<int> body) {
  final type = (headers['content-type'] ?? headers['Content-Type'] ?? '').toLowerCase();
  final textual = type.isEmpty
      ? _decodes(body)
      : type.startsWith('text/') || ['json', 'xml', 'javascript', 'x-www-form-urlencoded'].any(type.contains);
  final described = '[${body.length} bytes${type.isEmpty ? '' : ', ${type.split(';').first}'}]';
  if (!textual) return described;
  try {
    return redactText(utf8.decode(body, allowMalformed: true));
  } on Object {
    return described;
  }
}

bool _decodes(List<int> body) {
  try {
    utf8.decode(body);
    return true;
  } on FormatException {
    return false;
  }
}

Map<String, Object?> _exchange(Map<String, String> headers, List<int>? body) {
  final text = body == null || body.isEmpty ? null : _shown(headers, body);
  return {
    if (headers.isNotEmpty) 'headers': redactHeaders(headers),
    if (text != null) 'body': text.length > _most ? text.substring(0, _most) : text,
    if (text != null && text.length > _most) 'truncated': true,
  };
}

Map<String, String> _flat(HttpHeaders headers) {
  final out = <String, String>{};
  headers.forEach((name, values) => out[name] = values.join(', '));
  return out;
}

/// The app's requests, and the driver's rules for them.
class Network {
  Network({required this.trace});

  /// Where request events go: the agent's trace.
  final void Function(Map<String, Object?> event) trace;

  final _records = <_Record>[];
  // Ids keep rising across a hot restart: a runner asks for the requests after the last id it saw.
  var _nextId = DateTime.now().millisecondsSinceEpoch * 1000;
  var _inFlight = 0;
  var _answeringHere = 0;
  var _keepBodies = false;
  String? _traceparent;
  var _rules = <_Rule>[];
  var _holds = <_Hold>[];
  var _held = <_Held>[];

  /// A held request is kept out of this count: the point of holding it is to look at the loading state, so `idle`
  /// must not wait for it.
  int get inFlight => math.max(0, _inFlight - _held.length);
  int get held => _held.length;

  /// The requests out to a real server. A mocked one is answered by the agent's own timer, which runs on a host's
  /// clock, so a host with its own clock fast-forwards through its delay; it keeps the wall's pace only for these.
  int get onWire => math.max(0, inFlight - _answeringHere);

  /// Where a host replays recorded fetches from, for the hosts [fenced] says the app may not reach.
  NetCache? replay;
  bool Function(String host) fenced = (_) => true;

  /// Records remote fetches for the driver to keep, on a run where the network is real.
  final recorder = NetRecorder();

  /// Hosts never recorded: this machine and the emulator's name for it.
  Set<String> local = defaultNetworkHosts;

  /// Told when [inFlight] or [onWire] may have changed.
  void Function()? onInFlight;

  /// Wraps every HttpClient the app makes from now on, inside whatever overrides it had.
  void install() => HttpOverrides.global = _Overrides(this, HttpOverrides.current);

  Map<String, Object?> requests(int? since) => {
    'inFlight': inFlight,
    'held': held,
    'requests': [
      for (final r in _records)
        if (since == null || r.id > since) r.toJson(),
    ],
  };

  late final Map<String, FutureOr<Object?> Function(Object? params)> commands = {
    'netmock': _netmock,
    'netcache': _netcache,
    'networkBodies': (params) {
      _keepBodies = params is Map && params['on'] == true;
      return {'bodies': _keepBodies};
    },
    'traceContext': (params) {
      final given = params is Map ? params['traceparent'] : null;
      _traceparent = given is String && RegExp(r'^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$').hasMatch(given) ? given : null;
      return {'traceparent': _traceparent};
    },
  };

  // The driver's side of recording: start or stop it, and take what was recorded so far (a piece at a time).
  Object? _netcache(Object? params) {
    final p = params is Map ? params : const {};
    if (p['take'] == true) return recorder.take();
    if (p['record'] is bool) {
      recorder
        ..on = p['record'] == true
        ..credentials = p['credentials'] == true;
    }
    return {'recording': recorder.on, 'replaying': replay?.folder.path};
  }

  Object? _netmock(Object? params) {
    final p = params is Map ? params : const {};
    final method = (p['method'] is String ? p['method'] as String : '*').toUpperCase();
    final path = p['path'] is String ? p['path'] as String : null;
    final times = p['times'] is num ? (p['times'] as num).toInt() : null;
    switch (p['action'] ?? 'add') {
      case 'add':
        if (path == null) throw ArgumentError('netmock: add needs a path (substring, or ^regex)');
        final body = p['body'];
        final headers = p['headers'];
        _rules.insert(
          0,
          _Rule(
            method: method,
            path: path,
            status: p['status'] is num ? (p['status'] as num).toInt() : 200,
            body: body == null || body is String ? body as String? : jsonEncode(body),
            headers: headers is Map ? {for (final e in headers.entries) '${e.key}': '${e.value}'} : null,
            delayMs: p['delayMs'] is num ? (p['delayMs'] as num).toInt() : null,
            times: times,
            lost: p['lost'] == true,
          ),
        );
        return {'rules': _rules.length};
      case 'hold':
        if (path == null) throw ArgumentError('netmock: hold needs a path (substring, or ^regex)');
        _holds.insert(0, _Hold(method, path, times));
        return {'holds': _holds.length, 'held': _held.length};
      case 'release':
        return {'released': _release(path == null ? null : (method, path)), 'held': _held.length};
      case 'clear':
        _rules = [];
        _holds = [];
        _release(null);
        return {'rules': 0};
      case 'list':
        return {
          'rules': [for (final r in _rules) r.toJson()],
          'holds': [for (final h in _holds) h.toJson()],
          'held': [
            for (final h in _held) {'method': h.method, 'path': h.path, 'heldMs': _ms() - h.since},
          ],
        };
      default:
        throw ArgumentError(
          'netmock: "${p['action']}" is answered by a host only; add, hold, release, clear and list work on a device',
        );
    }
  }

  int _release((String, String)? route) {
    final released = _held.where((h) => route == null || _matches(route.$1, route.$2, h.method, h.path)).toList();
    _held = _held.where((h) => !released.contains(h)).toList();
    onInFlight?.call();
    for (final h in released) {
      h.go.complete();
    }
    return released.length;
  }

  Future<void>? _holdFor(String method, Uri url) {
    if (_holds.isEmpty) return null;
    final path = _pathOf(url);
    final gate = _holds
        .where((h) => (h.times == null || h.hits < h.times!) && _matches(h.method, h.path, method, path))
        .firstOrNull;
    if (gate == null) return null;
    gate.hits++;
    final held = _Held(method, path, Completer<void>());
    _held.add(held);
    onInFlight?.call();
    return held.go.future;
  }

  _Rule? _mockFor(String method, Uri url) {
    if (_rules.isEmpty) return null;
    final path = _pathOf(url);
    final rule = _rules
        .where((r) => (r.times == null || r.hits < r.times!) && _matches(r.method, r.path, method, path))
        .firstOrNull;
    rule?.hits++;
    return rule;
  }

  _Record _track(String method, Uri url) {
    final record = _Record(_nextId++, method, redactUrl(url.toString()));
    _inFlight++;
    onInFlight?.call();
    _records.add(record);
    if (_records.length > _keep) _records.removeAt(0);
    return record;
  }

  void _answerHere(_Record record) {
    record.answeredHere = true;
    _answeringHere++;
    onInFlight?.call();
  }

  void _finish(_Record record, int status, [Object? error]) {
    if (record.finished) return;
    record.finished = true;
    _inFlight--;
    if (record.answeredHere) _answeringHere--;
    onInFlight?.call();
    record
      ..status = status
      ..ms = _ms() - record.startedAt;
    if (status == 0) record.error = error == null ? 'network error or aborted' : '$error';
    trace({
      'kind': 'request',
      'method': record.method,
      'url': record.url,
      'status': status,
      'ms': record.ms,
      'error': ?record.error,
      if (record.mocked) 'mocked': true,
      if (record.replayed) 'replayed': true,
    });
  }
}

class _Overrides extends HttpOverrides {
  _Overrides(this.network, this.previous);
  final Network network;
  final HttpOverrides? previous;

  @override
  HttpClient createHttpClient(SecurityContext? context) =>
      _Client(network, previous?.createHttpClient(context) ?? super.createHttpClient(context));
}

class _Client implements HttpClient {
  _Client(this.network, this.inner);
  final Network network;
  final HttpClient inner;

  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) async {
    final verb = method.toUpperCase();
    final record = network._track(verb, url);
    // A request the driver holds is out as far as the app can tell.
    final gate = network._holdFor(verb, url);
    if (gate != null) await gate;
    final rule = network._mockFor(verb, url);
    final keep = network._keepBodies;
    if (rule != null && !rule.lost) {
      network._answerHere(record);
      return _MockRequest(network, record, rule, method, url, keep: keep);
    }
    // After netmock and before the fence: a fetch the host may not make, answered as a reference run recorded it.
    final replayed = verb == 'GET' && network.fenced(url.host) ? network.replay?.read(url) : null;
    if (replayed != null) {
      network._answerHere(record);
      final answer = _Rule(
        method: verb,
        path: url.path,
        status: replayed.status,
        headers: replayed.headers,
        bytes: replayed.body,
        replayed: true,
      );
      return _MockRequest(network, record, answer, method, url, keep: keep);
    }
    final HttpClientRequest request;
    try {
      request = await inner.openUrl(method, url);
    } catch (error) {
      network._finish(record, 0, error);
      rethrow;
    }
    final traceparent = network._traceparent;
    if (traceparent != null) request.headers.set('traceparent', traceparent);
    return _TrackedRequest(network, record, request, keep: keep, lose: rule?.lost ?? false);
  }

  @override
  Future<HttpClientRequest> open(String method, String host, int port, String path) =>
      openUrl(method, Uri(scheme: 'http', host: host, port: port).resolve(path));
  @override
  Future<HttpClientRequest> get(String host, int port, String path) => open('GET', host, port, path);
  @override
  Future<HttpClientRequest> getUrl(Uri url) => openUrl('GET', url);
  @override
  Future<HttpClientRequest> post(String host, int port, String path) => open('POST', host, port, path);
  @override
  Future<HttpClientRequest> postUrl(Uri url) => openUrl('POST', url);
  @override
  Future<HttpClientRequest> put(String host, int port, String path) => open('PUT', host, port, path);
  @override
  Future<HttpClientRequest> putUrl(Uri url) => openUrl('PUT', url);
  @override
  Future<HttpClientRequest> delete(String host, int port, String path) => open('DELETE', host, port, path);
  @override
  Future<HttpClientRequest> deleteUrl(Uri url) => openUrl('DELETE', url);
  @override
  Future<HttpClientRequest> patch(String host, int port, String path) => open('PATCH', host, port, path);
  @override
  Future<HttpClientRequest> patchUrl(Uri url) => openUrl('PATCH', url);
  @override
  Future<HttpClientRequest> head(String host, int port, String path) => open('HEAD', host, port, path);
  @override
  Future<HttpClientRequest> headUrl(Uri url) => openUrl('HEAD', url);

  @override
  bool get autoUncompress => inner.autoUncompress;
  @override
  set autoUncompress(bool value) => inner.autoUncompress = value;
  @override
  Duration? get connectionTimeout => inner.connectionTimeout;
  @override
  set connectionTimeout(Duration? value) => inner.connectionTimeout = value;
  @override
  Duration get idleTimeout => inner.idleTimeout;
  @override
  set idleTimeout(Duration value) => inner.idleTimeout = value;
  @override
  int? get maxConnectionsPerHost => inner.maxConnectionsPerHost;
  @override
  set maxConnectionsPerHost(int? value) => inner.maxConnectionsPerHost = value;
  @override
  String? get userAgent => inner.userAgent;
  @override
  set userAgent(String? value) => inner.userAgent = value;
  @override
  void addCredentials(Uri url, String realm, HttpClientCredentials credentials) =>
      inner.addCredentials(url, realm, credentials);
  @override
  void addProxyCredentials(String host, int port, String realm, HttpClientCredentials credentials) =>
      inner.addProxyCredentials(host, port, realm, credentials);
  @override
  set authenticate(Future<bool> Function(Uri url, String scheme, String? realm)? f) => inner.authenticate = f;
  @override
  set authenticateProxy(Future<bool> Function(String host, int port, String scheme, String? realm)? f) =>
      inner.authenticateProxy = f;
  @override
  set badCertificateCallback(bool Function(X509Certificate cert, String host, int port)? callback) =>
      inner.badCertificateCallback = callback;
  @override
  set connectionFactory(Future<ConnectionTask<Socket>> Function(Uri url, String? proxyHost, int? proxyPort)? f) =>
      inner.connectionFactory = f;
  @override
  set findProxy(String Function(Uri url)? f) => inner.findProxy = f;
  @override
  set keyLog(Function(String line)? callback) => inner.keyLog = callback;
  @override
  void close({bool force = false}) => inner.close(force: force);
}

/// Keeps what the app writes, while bodies are on, up to what a report shows.
class _Body {
  _Body(this.on);
  final bool on;
  final bytes = <int>[];
  void add(List<int> data) {
    if (on && bytes.length <= _most * 4) bytes.addAll(data);
  }
}

class _TrackedRequest implements HttpClientRequest {
  _TrackedRequest(this.network, this.record, this.inner, {required bool keep, required this.lose})
    : body = _Body(keep) {
    // `done` is there for an app that asks; a failure must not go unhandled when none does.
    _done.future.ignore();
  }
  final Network network;
  final _Record record;
  final HttpClientRequest inner;
  final bool lose;
  final _Body body;
  final _done = Completer<HttpClientResponse>();

  @override
  Future<HttpClientResponse> close() async {
    try {
      final response = await inner.close();
      if (body.on) record.request = _exchange(_flat(inner.headers), body.bytes);
      if (lose) {
        // The server got the request and acted on it; the app never hears back.
        record.mocked = true;
        await response.drain<void>().catchError((_) {});
        throw const HttpException('Connection closed while receiving data');
      }
      if (response.headers.value(mockedHeader) != null) record.mocked = true;
      // Done when the answer arrives, as an XMLHttpRequest's load is: an app may never read a body it does not want
      // (an image loader turning down a status), and such a request would otherwise keep the screen busy forever.
      network._finish(record, response.statusCode);
      final recording =
          !record.mocked &&
          network.recorder.wants(record.method, inner.uri, inner.headers, inner.cookies, network.local);
      final tracked = _TrackedResponse(
        network,
        record,
        response,
        keep: body.on,
        recording: recording ? inner.uri : null,
      );
      _done.complete(tracked);
      return tracked;
    } catch (error) {
      network._finish(record, 0, error);
      if (!_done.isCompleted) _done.completeError(error);
      rethrow;
    }
  }

  @override
  Future<HttpClientResponse> get done => _done.future;

  @override
  void add(List<int> data) {
    body.add(data);
    inner.add(data);
  }

  @override
  Future<void> addStream(Stream<List<int>> stream) => inner.addStream(
    stream.map((data) {
      body.add(data);
      return data;
    }),
  );

  @override
  void write(Object? object) {
    final text = '$object';
    body.add(encoding.encode(text));
    inner.write(text);
  }

  @override
  void writeAll(Iterable<Object?> objects, [String separator = '']) => write(objects.join(separator));
  @override
  void writeln([Object? object = '']) => write('$object\n');
  @override
  void writeCharCode(int charCode) => write(String.fromCharCode(charCode));
  @override
  void addError(Object error, [StackTrace? stackTrace]) => inner.addError(error, stackTrace);
  @override
  Future<void> flush() => inner.flush();
  @override
  void abort([Object? exception, StackTrace? stackTrace]) => inner.abort(exception, stackTrace);

  @override
  Encoding get encoding => inner.encoding;
  @override
  set encoding(Encoding value) => inner.encoding = value;
  @override
  bool get bufferOutput => inner.bufferOutput;
  @override
  set bufferOutput(bool value) => inner.bufferOutput = value;
  @override
  int get contentLength => inner.contentLength;
  @override
  set contentLength(int value) => inner.contentLength = value;
  @override
  bool get followRedirects => inner.followRedirects;
  @override
  set followRedirects(bool value) => inner.followRedirects = value;
  @override
  int get maxRedirects => inner.maxRedirects;
  @override
  set maxRedirects(int value) => inner.maxRedirects = value;
  @override
  bool get persistentConnection => inner.persistentConnection;
  @override
  set persistentConnection(bool value) => inner.persistentConnection = value;
  @override
  HttpConnectionInfo? get connectionInfo => inner.connectionInfo;
  @override
  List<Cookie> get cookies => inner.cookies;
  @override
  HttpHeaders get headers => inner.headers;
  @override
  String get method => inner.method;
  @override
  Uri get uri => inner.uri;
}

class _TrackedResponse extends Stream<List<int>> implements HttpClientResponse {
  _TrackedResponse(this.network, this.record, this.inner, {required bool keep, this.recording})
    : body = _Body(keep),
      recorded = recording != null ? BytesBuilder(copy: false) : null;
  final Network network;
  final _Record record;
  final HttpClientResponse inner;
  final _Body body;

  /// The URL the app asked for and the whole body, for the driver to keep, when this fetch is being recorded.
  final Uri? recording;
  final BytesBuilder? recorded;

  var _ended = false;

  void _end([Object? error]) {
    if (_ended) return;
    _ended = true;
    // The recording first: it must not depend on how the log shows the body.
    if (error == null && recording != null) {
      network.recorder.add(recording!, inner.statusCode, inner.headers, recorded!.takeBytes());
    }
    if (body.on) record.response = _exchange(_flat(inner.headers), body.bytes);
    if (error != null) record.error ??= '$error';
  }

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    final subscription = inner.listen(
      (data) {
        body.add(data);
        recorded?.add(data);
        onData?.call(data);
      },
      onError: (Object error, StackTrace stack) {
        _end(error);
        if (onError is void Function(Object, StackTrace)) {
          onError(error, stack);
        } else if (onError is void Function(Object)) {
          onError(error);
        }
      },
      onDone: () {
        _end();
        onDone?.call();
      },
      cancelOnError: cancelOnError,
    );
    return _Ending(subscription, _end);
  }

  @override
  X509Certificate? get certificate => inner.certificate;
  @override
  HttpClientResponseCompressionState get compressionState => inner.compressionState;
  @override
  HttpConnectionInfo? get connectionInfo => inner.connectionInfo;
  @override
  int get contentLength => inner.contentLength;
  @override
  List<Cookie> get cookies => inner.cookies;
  @override
  Future<Socket> detachSocket() => inner.detachSocket();
  @override
  HttpHeaders get headers => inner.headers;
  @override
  bool get isRedirect => inner.isRedirect;
  @override
  bool get persistentConnection => inner.persistentConnection;
  @override
  String get reasonPhrase => inner.reasonPhrase;
  @override
  Future<HttpClientResponse> redirect([String? method, Uri? url, bool? followLoops]) =>
      inner.redirect(method, url, followLoops);
  @override
  List<RedirectInfo> get redirects => inner.redirects;
  @override
  int get statusCode => inner.statusCode;
}

/// A subscription that counts the request as over when the app stops reading it before the end.
class _Ending implements StreamSubscription<List<int>> {
  _Ending(this.inner, this.end);
  final StreamSubscription<List<int>> inner;
  final void Function() end;

  @override
  Future<void> cancel() {
    end();
    return inner.cancel();
  }

  // drain() and the like end the stream through asFuture or onDone, which replace the handlers given to listen.
  @override
  Future<E> asFuture<E>([E? futureValue]) => inner.asFuture(futureValue).whenComplete(end);
  @override
  bool get isPaused => inner.isPaused;
  @override
  void onData(void Function(List<int> data)? handleData) => inner.onData(handleData);
  @override
  void onDone(void Function()? handleDone) => inner.onDone(() {
    end();
    handleDone?.call();
  });
  @override
  void onError(Function? handleError) => inner.onError(handleError);
  @override
  void pause([Future<void>? resumeSignal]) => inner.pause(resumeSignal);
  @override
  void resume() => inner.resume();
}

/// Headers kept in a map, for a request no server will see and an answer no server gave.
class _Headers implements HttpHeaders {
  final _values = <String, List<String>>{};

  @override
  List<String>? operator [](String name) => _values[name.toLowerCase()];
  @override
  String? value(String name) => _values[name.toLowerCase()]?.join(', ');
  @override
  void add(String name, Object value, {bool preserveHeaderCase = false}) =>
      (_values[name.toLowerCase()] ??= []).add('$value');
  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) => _values[name.toLowerCase()] = ['$value'];
  @override
  void remove(String name, Object value) => _values[name.toLowerCase()]?.remove('$value');
  @override
  void removeAll(String name) => _values.remove(name.toLowerCase());
  @override
  void forEach(void Function(String name, List<String> values) action) => _values.forEach(action);
  @override
  void clear() => _values.clear();
  @override
  void noFolding(String name) {}
  @override
  ContentType? get contentType {
    final type = value(HttpHeaders.contentTypeHeader);
    return type == null ? null : ContentType.parse(type);
  }

  @override
  set contentType(ContentType? type) =>
      type == null ? removeAll(HttpHeaders.contentTypeHeader) : set(HttpHeaders.contentTypeHeader, type);
  @override
  int get contentLength => int.tryParse(value(HttpHeaders.contentLengthHeader) ?? '') ?? -1;
  @override
  set contentLength(int length) => set(HttpHeaders.contentLengthHeader, length);
  @override
  bool chunkedTransferEncoding = false;
  @override
  bool persistentConnection = true;
  @override
  DateTime? date;
  @override
  DateTime? expires;
  @override
  String? host;
  @override
  DateTime? ifModifiedSince;
  @override
  int? port;
}

/// A request a rule answers: it never opens a connection.
class _MockRequest implements HttpClientRequest {
  _MockRequest(this.network, this.record, this.rule, this.method, this.uri, {required bool keep}) : body = _Body(keep);
  final Network network;
  final _Record record;
  final _Rule rule;
  final _Body body;
  final _done = Completer<HttpClientResponse>();

  @override
  final String method;
  @override
  final Uri uri;
  @override
  final HttpHeaders headers = _Headers();
  @override
  final List<Cookie> cookies = [];
  @override
  Encoding encoding = utf8;
  @override
  bool bufferOutput = true;
  @override
  int contentLength = -1;
  @override
  bool followRedirects = true;
  @override
  int maxRedirects = 5;
  @override
  bool persistentConnection = true;
  @override
  HttpConnectionInfo? get connectionInfo => null;

  @override
  Future<HttpClientResponse> close() async {
    final delay = rule.delayMs;
    if (delay != null && delay > 0) await Future<void>.delayed(Duration(milliseconds: delay));
    final sent = rule.bytes ?? utf8.encode(rule.body ?? (rule.status == 204 ? '' : '{}'));
    final answer = _Headers();
    if (!rule.replayed) answer.set(HttpHeaders.contentTypeHeader, 'application/json');
    rule.headers?.forEach(answer.set);
    if (rule.replayed) {
      record.replayed = true;
    } else {
      record.mocked = true;
    }
    if (body.on) {
      record
        ..request = _exchange(_flat(headers), body.bytes)
        ..response = _exchange(_flat(answer), sent);
    }
    network._finish(record, rule.status);
    final response = _MockResponse(rule.status, answer, sent);
    _done.complete(response);
    return response;
  }

  @override
  Future<HttpClientResponse> get done => _done.future;
  @override
  void add(List<int> data) => body.add(data);
  @override
  Future<void> addStream(Stream<List<int>> stream) => stream.forEach(body.add);
  @override
  void write(Object? object) => body.add(encoding.encode('$object'));
  @override
  void writeAll(Iterable<Object?> objects, [String separator = '']) => write(objects.join(separator));
  @override
  void writeln([Object? object = '']) => write('$object\n');
  @override
  void writeCharCode(int charCode) => write(String.fromCharCode(charCode));
  @override
  void addError(Object error, [StackTrace? stackTrace]) {}
  @override
  Future<void> flush() async {}
  @override
  void abort([Object? exception, StackTrace? stackTrace]) {}
}

class _MockResponse extends Stream<List<int>> implements HttpClientResponse {
  _MockResponse(this.statusCode, this.headers, this._body);
  final List<int> _body;

  @override
  final int statusCode;
  @override
  final HttpHeaders headers;

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) => Stream<List<int>>.fromIterable([
    if (_body.isNotEmpty) _body,
  ]).listen(onData, onError: onError, onDone: onDone, cancelOnError: cancelOnError);

  @override
  X509Certificate? get certificate => null;
  @override
  HttpClientResponseCompressionState get compressionState => HttpClientResponseCompressionState.notCompressed;
  @override
  HttpConnectionInfo? get connectionInfo => null;
  @override
  int get contentLength => _body.length;
  @override
  List<Cookie> get cookies => const [];
  @override
  Future<Socket> detachSocket() => throw UnsupportedError('A mocked answer has no socket');
  @override
  bool get isRedirect => false;
  @override
  bool get persistentConnection => false;
  @override
  String get reasonPhrase => statusCode < 400 ? 'OK' : 'Mocked';
  @override
  Future<HttpClientResponse> redirect([String? method, Uri? url, bool? followLoops]) =>
      throw UnsupportedError('A mocked answer does not redirect');
  @override
  List<RedirectInfo> get redirects => const [];
}
