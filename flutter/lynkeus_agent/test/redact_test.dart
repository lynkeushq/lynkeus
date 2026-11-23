import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_agent/src/redact.dart';

// Ported from packages/agent/src/__tests__/redact.test.ts: both agents must read the same names as secrets.
void main() {
  group('sensitiveKey', () {
    for (final key in [
      'password', 'newPassword', 'passcode', 'passwd', 'pin', 'pin_code', 'pinCode', 'otp', 'secret', //
      'clientSecret', 'authorization', 'auth', 'cookie', 'credentials', 'jwt', 'signature', 'csrf', 'xsrf',
      'x-csrf-token', 'cvv', 'cvc', 'ssn', 'token', 'accessToken', 'refresh_token', 'idToken', 'apiKey', 'api_key',
      'APIKey', 'x-api-key', 'X-Api-Key', 'apikey', 'cardNumber', 'card_number', 'sessionToken', 'sessionId',
      'session_id', 'privateKey', 'private-key', 'code', 'key', 'session', 'pan', 'sessionKey', 'accessKey',
      'accessKeyId', 'authCode', 'auth_code', 'inviteCode', 'verificationCode', 'licenseKey', 'encryptionKey',
      'authHeader', 'userSession', 'pwd', 'passphrase', 'pass_word', 'passwords', 'secrets', 'refreshTok', 'sid',
      'iban', 'mnemonic', 'seed', 'recoveryPhrase',
    ]) {
      test('redacts $key', () => expect(sensitiveKey(key), isTrue));
    }

    for (final key in [
      'passed', 'bypass', 'span', 'compass', 'footprint', 'tokens', 'keyboard', 'monkey', 'zipcode', 'author', //
      'authors', 'pinned', 'sessionCount', 'codec', 'status', 'page', 'tokenCount', 'passwordLength', 'statusCode',
      'errorCode', 'countryCode', 'currencyCode', 'keyboardType', 'itemKey', 'cacheKey', 'sortKey', 'keyExtractor',
    ]) {
      test('keeps $key', () => expect(sensitiveKey(key), isFalse));
    }

    test('redacts header pairs by name, Basic credentials and pwd in text', () {
      expect(
        redactValue([
          ['X-Api-Key', 'k'],
          ['Accept', 'json'],
        ]),
        [
          ['X-Api-Key', '…'],
          ['Accept', 'json'],
        ],
      );
      expect(redactValue({'note': 'sent Basic dXNlcjpodW50ZXIy'}), {'note': 'sent Basic …'});
      expect(redactText('pwd=hunter2&user=a'), 'pwd=…&user=a');
      expect(redactText('{"pwd":"hunter2"}'), isNot(contains('hunter2')));
    });
  });

  group('redactValue', () {
    test('survives a self reference', () {
      final a = <String, Object?>{'name': 'a'};
      a['self'] = a;
      expect(redactValue(a), {'name': 'a', 'self': '[circular]'});
    });

    test('redacts secrets inside strings: a URL query, and JSON kept as text', () {
      expect(redactValue({'url': 'https://a.com/verify?token=abc123&lang=es'}), {
        'url': 'https://a.com/verify?token=…&lang=es',
      });
      final body =
          (redactValue({'body': '{"accessToken":"abcdef123456","next":"https://a.com/x?code=99"}'})! as Map)['body']
              as String;
      expect(jsonDecode(body), {'accessToken': '…', 'next': 'https://a.com/x?code=…'});
      expect(redactText(jsonEncode({'link': 'https://a.com/magic?token=zzz', 'name': 'Ana'})), isNot(contains('zzz')));
      expect(redactValue('{not json token=abc'), '{not json token=…');
    });

    test('redacts names written as one word, and headers given as name/value objects', () {
      for (final key in ['accesstoken', 'refreshtoken', 'privatekey', 'sessionid', 'pincode', 'cardnumber']) {
        expect(sensitiveKey(key), isTrue, reason: key);
      }
      for (final key in ['zipcode', 'statuscode', 'username']) {
        expect(sensitiveKey(key), isFalse, reason: key);
      }
      expect(
        redactValue([
          {'name': 'X-Api-Key', 'value': 'k1'},
          {'name': 'Accept', 'value': 'json'},
        ]),
        [
          {'name': 'X-Api-Key', 'value': '…'},
          {'name': 'Accept', 'value': 'json'},
        ],
      );
    });

    test('redacts by key at any depth', () {
      expect(
        redactValue({
          'a': {'accessToken': 'x', 'tokens': 3, 'passed': true},
        }),
        {
          'a': {'accessToken': '…', 'tokens': 3, 'passed': true},
        },
      );
    });

    test('redacts JWTs and secret path segments', () {
      expect(redactString('id eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdEFGH1234'), 'id …');
      expect(redactString('https://a.com/reset-password/abcdefghijklmnop/done'), 'https://a.com/reset-password/…/done');
      expect(redactString('https://a.com/otp/123456?x=1'), 'https://a.com/otp/…?x=1');
    });
  });

  group('redactText', () {
    for (final body in ['Waiting for monkey: x', 'zipcode: 90210 invalid', 'bypass: on', 'Error code: 5']) {
      test('keeps prose $body', () => expect(redactText(body), body));
    }
    for (final body in [
      'password: hunter2',
      'X-Api-Key: abc',
      '{password: abc',
      'a=1; token: abc',
      '"accessToken": abc,',
    ]) {
      test('withholds $body', () => expect(redactText(body), '[unparsed body redacted]'));
    }
    test('redacts name=value pairs by word', () {
      expect(redactText('monkey=1&token=abc&accessToken=def&spin=2'), 'monkey=1&token=…&accessToken=…&spin=2');
    });
  });

  group('request helpers', () {
    test('redacts api key headers in any case', () {
      expect(redactHeaders({'x-api-key': 'a', 'X-Api-Key': 'b', 'Accept': 'c'}), {'x-api-key': '…', 'accept': 'c'});
    });
    test('keeps harmless query keys', () {
      expect(redactUrl('https://a/x?passed=1&keyword=k&token=t'), 'https://a/x?passed=1&keyword=k&token=…');
    });
    test('hides the credentials in a URL', () {
      expect(redactUrl('https://ana:hunter2@a.com/x'), 'https://…:…@a.com/x');
    });
  });
}
