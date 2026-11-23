import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

/*
 * Remote fetches recorded once where the network is real (a simulator, an emulator, a phone, or a host with its fence
 * opened) and replayed on a host, which stays off the internet: a screen with a network image then shows the same
 * picture on both sides. The folder is the React Native host's --net_cache: one file per URL, named by the first 16
 * bytes of the URL's SHA-256 in hex, holding the body; an empty file is a URL that was asked for and not had. Beside
 * it, `<name>.json` keeps what a Flutter app also reads: the URL, the status and the headers below.
 */

/// The headers kept with a recorded body: what a client decides on. The body is stored as the app read it
/// (decompressed), so length and encoding are not kept.
const keptHeaders = ['content-type', 'cache-control', 'expires', 'etag', 'last-modified', 'date'];

/// The file a URL is kept in, as the React Native host names it.
String netCacheName(String url) =>
    sha256.convert(utf8.encode(url)).bytes.take(16).map((b) => b.toRadixString(16).padLeft(2, '0')).join();

/// A recorded answer.
typedef CachedAnswer = ({int status, Map<String, String> headers, Uint8List body});

/// A folder of recorded answers, read on a host.
class NetCache {
  NetCache(this.folder);
  final Directory folder;

  CachedAnswer? read(Uri url) {
    final name = netCacheName('$url');
    final body = File('${folder.path}/$name');
    if (!body.existsSync()) return null;
    final bytes = body.readAsBytesSync();
    if (bytes.isEmpty) return null;
    final meta = File('${folder.path}/$name.json');
    var status = 200;
    var headers = const <String, String>{};
    if (meta.existsSync()) {
      final json = jsonDecode(meta.readAsStringSync());
      if (json is Map) {
        status = json['status'] is int ? json['status'] as int : 200;
        final h = json['headers'];
        if (h is Map) headers = {for (final e in h.entries) '${e.key}': '${e.value}'};
      }
    }
    return (status: status, headers: headers, body: bytes);
  }
}

/// What the agent records for the driver to take: successful remote GETs, never one that carried credentials unless
/// asked to.
class NetRecorder {
  var on = false;

  /// Also record requests that sent an Authorization header or cookies.
  var credentials = false;

  final _entries = <({String url, int status, Map<String, String> headers, List<int> body})>[];
  var _bytes = 0;

  // A reference run of a few dozen screens stays well under this; past it the oldest go first.
  static const _most = 64 << 20;

  bool wants(String method, Uri url, HttpHeaders sent, List<Cookie> cookies, Set<String> local) {
    if (!on || method != 'GET' || local.contains(url.host)) return false;
    if (credentials) return true;
    return sent.value(HttpHeaders.authorizationHeader) == null &&
        sent.value(HttpHeaders.cookieHeader) == null &&
        cookies.isEmpty;
  }

  void add(Uri url, int status, HttpHeaders headers, List<int> body) {
    if (status < 200 || status >= 300) return;
    final kept = <String, String>{
      for (final name in keptHeaders)
        if (headers.value(name) != null) name: headers.value(name)!,
    };
    _entries.add((url: '$url', status: status, headers: kept, body: body));
    _bytes += body.length;
    while (_bytes > _most && _entries.length > 1) {
      _bytes -= _entries.removeAt(0).body.length;
    }
  }

  /// The recorded answers since the last take, at most about [budget] bytes of bodies at a time.
  Map<String, Object?> take({int budget = 8 << 20}) {
    final out = <Map<String, Object?>>[];
    var size = 0;
    while (_entries.isNotEmpty && (out.isEmpty || size < budget)) {
      final next = _entries.removeAt(0);
      size += next.body.length;
      _bytes -= next.body.length;
      out.add({'url': next.url, 'status': next.status, 'headers': next.headers, 'body': base64.encode(next.body)});
    }
    return {'entries': out, 'left': _entries.length};
  }
}
