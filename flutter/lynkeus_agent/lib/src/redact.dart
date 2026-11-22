import 'dart:convert';

// A port of packages/agent/src/redact.ts: the same names are secrets on every runtime, so a report reads the same
// whichever agent filled it.

const _sensitiveNames = [
  'token',
  'key',
  'secret',
  'code',
  'otp',
  'password',
  'pin',
  'session',
  'auth',
  'pwd',
  'pass',
  'passphrase',
  'sid',
];

String _capitalized(String n) => '${n[0].toUpperCase()}${n.substring(1)}';

/// `name=value` inside free text. A name counts as its own word (`monkey=` and `spin=` do not) or as the tail of a
/// camelCase name (`accessToken=`).
final sensitive = RegExp(
  '(${_sensitiveNames.map((n) => '(?<![A-Za-z0-9])(?:$n|${n.toUpperCase()}|${_capitalized(n)})|(?<=[a-z0-9])${_capitalized(n)}').join('|')})(=|%3[dD])[^&#]*',
);

const _secretWords = {
  'password', 'passwords', 'pwd', 'pass', 'passphrase', 'secrets', 'tok', 'sid', 'iban', 'mnemonic', 'seed', //
  'passcode', 'passwd', 'pin', 'otp', 'secret', 'authorization', 'cookie', 'credential', 'credentials', 'jwt',
  'signature', 'csrf', 'xsrf', 'cvv', 'cvc', 'ssn', 'token',
};
const _secretPairs = {
  'api key',
  'card number',
  'pin code',
  'session token',
  'session id',
  'private key',
  'recovery phrase',
  'seed phrase',
  'secret phrase',
};
const _secretWhole = {'auth', 'code', 'key', 'session', 'pan', 'apikey', 'x-api-key'};
// Names written as one lowercase word, which the word split cannot separate (`accesstoken`, `sessionid`).
const _secretFused = {
  'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'sessiontoken', 'sessionid', 'privatekey', 'secretkey', //
  'accesskey', 'clientsecret', 'apisecret', 'pincode', 'cardnumber', 'securitycode', 'verificationcode',
};
// An auth word anywhere in a longer name is a secret's name (`authHeader`); a key is one after these words
// (`sessionKey`, `accessKeyId`, `licenseKey`), not after `item`, `cache` or `sort`.
const _secretAny = {'auth'};
const _secretKeyAfter = {
  'session', 'access', 'license', 'encryption', 'private', 'secret', 'signing', 'master', 'client', 'crypto', 'aes', //
  'hmac', 'ssh', 'gpg', 'pgp', 'account', 'product', 'activation', 'recovery', 'wallet', 'root', 'admin', 'service',
  'storage', 'app', 'auth', 'refresh', 'decryption',
};
// A code is secret after these words (`authCode`, `inviteCode`), not after `status`, `error`, `country` or `zip`.
const _secretCodeAfter = {
  'auth', 'invite', 'invitation', 'verification', 'verify', 'access', 'reset', 'promo', 'otp', 'sms', //
  'confirmation', 'confirm', 'security', 'recovery', 'activation', 'pairing', 'login', 'mfa', 'totp', 'backup', 'one',
  'time',
};
// A name that ends in one of these describes a secret, it is not one (`tokenCount`, `passwordLength`, `keyType`).
const _aboutASecret = {'count', 'counts', 'length', 'type', 'limit', 'limits', 'usage', 'used'};

List<String> _keyWords(String key) => key
    .replaceAllMapped(RegExp('([a-z0-9])([A-Z])'), (m) => '${m[1]} ${m[2]}')
    .replaceAllMapped(RegExp('([A-Z])([A-Z][a-z])'), (m) => '${m[1]} ${m[2]}')
    .split(RegExp('[^A-Za-z0-9]+'))
    .where((w) => w.isNotEmpty)
    .map((w) => w.toLowerCase())
    .toList();

/// Matches words, so `passed`, `bypass`, `span`, `tokens` and `statusCode` stay readable while `accessToken`,
/// `sessionKey`, `authCode` and `X-Api-Key` do not.
bool sensitiveKey(String key) {
  final words = _keyWords(key);
  if (_secretWhole.contains(key.toLowerCase()) || _secretWhole.contains(words.join())) return true;
  if (_secretFused.contains(words.join())) return true;
  if (words.length > 1 && _aboutASecret.contains(words.last)) return false;
  for (var index = 0; index < words.length; index++) {
    final word = words[index];
    final before = index > 0 ? words[index - 1] : null;
    if (_secretWords.contains(word) ||
        (words.length > 1 && _secretAny.contains(word)) ||
        ((word == 'key' || word == 'keys') && before != null && _secretKeyAfter.contains(before)) ||
        (word == 'code' && before != null && _secretCodeAfter.contains(before)) ||
        (word == 'session' && index == words.length - 1 && words.length > 1) ||
        (before != null && _secretPairs.contains('$before $word'))) {
      return true;
    }
  }
  return false;
}

// A key only counts in key position (start of a line, or after `{ , ; &`), so prose like "Waiting for monkey: x" is
// kept.
final _textKey = RegExp(r'''(?:^|[{,;&])[ \t]*["']?([\w.-]+)["']?[ \t]*:''', multiLine: true);
bool _hasSecretKey(String body) => _textKey.allMatches(body).any((m) => sensitiveKey(m[1]!));

final _jwtValue = RegExp(r'\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b');
final _bearerValue = RegExp(r'\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/-]{8,}={0,2}', caseSensitive: false);
const _pathKeys = {
  'token', 'key', 'keys', 'secret', 'secrets', 'code', 'codes', 'otp', 'password', 'password-reset', //
  'reset-password', 'pin', 'session', 'sessions', 'credential', 'credentials', 'jwt', 'signature', 'csrf', 'xsrf',
};

String _redactPathSecrets(String value) {
  final parts = value.split('/');
  for (var index = 1; index < parts.length; index++) {
    final split = RegExp(r'^([^?#]*)(.*)$').firstMatch(parts[index])!;
    final secret = split[1]!;
    final suffix = split[2]!;
    String name;
    try {
      name = Uri.decodeComponent(parts[index - 1]).toLowerCase();
    } catch (_) {
      continue;
    }
    if (!_pathKeys.contains(name)) continue;
    if (secret.length >= 12 ||
        ((name == 'otp' || name == 'pin' || name == 'code') && RegExp(r'^\d{4,8}$').hasMatch(secret))) {
      parts[index] = '…$suffix';
    }
  }
  return parts.join('/');
}

String _nameRule(String value) => value.replaceAllMapped(sensitive, (m) => '${m[1]}=…');

String redactString(String value) =>
    _redactPathSecrets(value.replaceAll(_jwtValue, '…').replaceAllMapped(_bearerValue, (m) => '${m[1]}…'));

const _maxNodes = 10000;

class _Walk {
  final path = Set<Object>.identity();
  var nodes = 0;
}

// A string can carry its own secrets: a URL's `?token=`, a form body, or JSON kept as text. JSON text is walked like
// the value it encodes and written back compact; anything else gets the `name=` rule.
String _walkString(String value, int depth, _Walk state) {
  final trimmed = value.trimLeft();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && depth < 100) {
    try {
      return jsonEncode(_walk(jsonDecode(value), depth + 1, state));
    } on FormatException {
      // Not JSON after all: the text rules below.
    }
  }
  return redactString(_nameRule(value));
}

Object? _walk(Object? value, int depth, _Walk state) {
  if (value is String) return _walkString(value, depth, state);
  if (value is! Map && value is! List) return value;
  if (depth >= 100) return '[nested data removed]';
  if (state.path.contains(value)) return '[circular]';
  if (++state.nodes > _maxNodes) return '[truncated]';
  state.path.add(value!);
  try {
    if (value is List) {
      // A header list keeps its pairs as [name, value]: the name decides, as an object key would.
      if (value.length == 2 && value[0] is String && sensitiveKey(value[0] as String)) return [value[0], '…'];
      return [for (final item in value) _walk(item, depth + 1, state)];
    }
    final map = value as Map;
    // A header given as an object, `{ name: 'X-Api-Key', value: '…' }`: the name decides, as a key would.
    final name = map['name'] ?? map['key'];
    if (map.length == 2 && map.containsKey('value') && name is String && sensitiveKey(name)) {
      return {...map, 'value': '…'};
    }
    return {
      for (final entry in map.entries)
        '${entry.key}': sensitiveKey('${entry.key}') ? '…' : _walk(entry.value, depth + 1, state),
    };
  } finally {
    state.path.remove(value);
  }
}

Object? redactValue(Object? value) => _walk(value, 0, _Walk());

/// A body as text a report can show: JSON with its secrets replaced, a form's secret fields too.
String redactText(String body) {
  Object? parsed;
  try {
    parsed = jsonDecode(body);
  } on FormatException {
    // An unparsed body cannot be walked safely: do not return text whose secret has an unfamiliar shape.
    if (_hasSecretKey(body)) return '[unparsed body redacted]';
    return redactString(_nameRule(body));
  }
  return const JsonEncoder.withIndent('  ').convert(redactValue(parsed));
}

const _redacted = '__lynkeus_redacted__';

/// Query strings are kept for their shape (page, filters), never for secrets.
String redactUrl(String input) {
  final Uri url;
  try {
    url = Uri.parse(input);
    if (!url.hasScheme) throw const FormatException();
  } on FormatException {
    return redactString(_nameRule(input));
  }
  final query = url.hasQuery
      ? url.queryParametersAll.entries
            .where((e) => !e.key.contains('='))
            .map((e) => MapEntry(e.key, sensitiveKey(e.key) ? [_redacted] : e.value))
      : null;
  var out = url.replace(
    userInfo: url.userInfo.isEmpty
        ? null
        : url.userInfo.contains(':')
        ? '$_redacted:$_redacted'
        : _redacted,
    queryParameters: query == null ? null : Map.fromEntries(query),
  );
  if (url.hasQuery && out.query.isEmpty) out = out.replace(query: null);
  return redactString(_nameRule(out.toString().replaceAll(_redacted, '…')));
}

Map<String, String> redactHeaders(Map<String, String> headers) => {
  for (final e in headers.entries) e.key.toLowerCase(): sensitiveKey(e.key) ? '…' : e.value,
};
