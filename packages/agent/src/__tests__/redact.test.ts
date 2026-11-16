import { describe, expect, it } from '@jest/globals';

import { redactText, redactValue, sensitiveKey } from '../redact';
import { redactHeaders, redactUrl } from '../requests';

describe('sensitiveKey', () => {
  it.each([
    'password',
    'newPassword',
    'passcode',
    'passwd',
    'pin',
    'pin_code',
    'pinCode',
    'otp',
    'secret',
    'clientSecret',
    'authorization',
    'auth',
    'cookie',
    'credentials',
    'jwt',
    'signature',
    'csrf',
    'xsrf',
    'x-csrf-token',
    'cvv',
    'cvc',
    'ssn',
    'token',
    'accessToken',
    'refresh_token',
    'idToken',
    'apiKey',
    'api_key',
    'APIKey',
    'x-api-key',
    'X-Api-Key',
    'apikey',
    'cardNumber',
    'card_number',
    'sessionToken',
    'sessionId',
    'session_id',
    'privateKey',
    'private-key',
    'code',
    'key',
    'session',
    'pan',
    'sessionKey',
    'accessKey',
    'accessKeyId',
    'authCode',
    'auth_code',
    'inviteCode',
    'verificationCode',
    'licenseKey',
    'encryptionKey',
    'authHeader',
    'userSession',
    'pwd',
    'passphrase',
    'pass_word',
    'passwords',
    'secrets',
    'refreshTok',
    'sid',
    'iban',
    'mnemonic',
    'seed',
    'recoveryPhrase',
  ])('redacts %s', (key) => expect(sensitiveKey(key)).toBe(true));

  it.each([
    'passed',
    'bypass',
    'span',
    'compass',
    'footprint',
    'tokens',
    'keyboard',
    'monkey',
    'zipcode',
    'author',
    'authors',
    'pinned',
    'sessionCount',
    'codec',
    'status',
    'page',
    'tokenCount',
    'passwordLength',
    'statusCode',
    'errorCode',
    'countryCode',
    'currencyCode',
    'keyboardType',
    'itemKey',
    'cacheKey',
    'sortKey',
    'keyExtractor',
    'passed',
    'bypass',
  ])('keeps %s', (key) => expect(sensitiveKey(key)).toBe(false));

  it('redacts header pairs by name, Basic credentials and pwd in text', () => {
    expect(
      redactValue([
        ['X-Api-Key', 'k'],
        ['Accept', 'json'],
      ]),
    ).toEqual([
      ['X-Api-Key', '…'],
      ['Accept', 'json'],
    ]);
    expect(redactValue({ note: 'sent Basic dXNlcjpodW50ZXIy' })).toEqual({ note: 'sent Basic …' });
    expect(redactText('pwd=hunter2&user=a')).toBe('pwd=…&user=a');
    expect(redactText('{"pwd":"hunter2"}')).not.toContain('hunter2');
  });
});

describe('redactValue', () => {
  const fast = (fn: () => unknown) => {
    const start = Date.now();
    const result = fn();
    expect(Date.now() - start).toBeLessThan(1000);
    return result;
  };

  it('survives a self reference', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(fast(() => redactValue(a))).toEqual({ name: 'a', self: '[circular]' });
  });

  it('survives a double self reference', () => {
    const a: Record<string, unknown> = {};
    a.x = a;
    a.y = a;
    expect(fast(() => redactValue(a))).toEqual({ x: '[circular]', y: '[circular]' });
  });

  it('survives an axios-error-like structure', () => {
    const request: Record<string, unknown> = { headers: { authorization: 'Bearer abcdefghijkl' } };
    const config: Record<string, unknown> = { request, url: '/x' };
    const response: Record<string, unknown> = { config, request, status: 500 };
    request.response = response;
    request.config = config;
    const error = { config, request, response, message: 'failed' };
    const out = fast(() => redactValue(error)) as { message: string };
    expect(out.message).toBe('failed');
    expect(JSON.stringify(out)).not.toContain('abcdefghijkl');
  });

  it('stays linear on a wide shared graph', () => {
    let node: unknown = { leaf: 1 };
    for (let i = 0; i < 60; i++) node = { a: node, b: node };
    expect(() => JSON.stringify(fast(() => redactValue(node)))).not.toThrow();
  });

  it('redacts secrets inside strings: a URL query, and JSON kept as text', () => {
    expect(redactValue({ url: 'https://a.com/verify?token=abc123&lang=es' })).toEqual({ url: 'https://a.com/verify?token=…&lang=es' });
    const body = redactValue({ body: '{"accessToken":"abcdef123456","next":"https://a.com/x?code=99"}' }) as { body: string };
    expect(JSON.parse(body.body)).toEqual({ accessToken: '…', next: 'https://a.com/x?code=…' });
    expect(redactText(JSON.stringify({ link: 'https://a.com/magic?token=zzz', name: 'Ana' }))).not.toContain('zzz');
    // Text that only looks like JSON stays text, still under the name= rule.
    expect(redactValue('{not json token=abc')).toBe('{not json token=…');
  });

  it('redacts names written as one word, and headers given as name/value objects', () => {
    for (const key of ['accesstoken', 'refreshtoken', 'privatekey', 'sessionid', 'pincode', 'cardnumber']) expect(sensitiveKey(key)).toBe(true);
    for (const key of ['zipcode', 'statuscode', 'username']) expect(sensitiveKey(key)).toBe(false);
    expect(
      redactValue([
        { name: 'X-Api-Key', value: 'k1' },
        { name: 'Accept', value: 'json' },
      ]),
    ).toEqual([
      { name: 'X-Api-Key', value: '…' },
      { name: 'Accept', value: 'json' },
    ]);
  });

  it('redacts by key at any depth', () => {
    expect(redactValue({ a: { accessToken: 'x', tokens: 3, passed: true } })).toEqual({ a: { accessToken: '…', tokens: 3, passed: true } });
  });
});

describe('redactText', () => {
  it.each(['Waiting for monkey: x', 'zipcode: 90210 invalid', 'bypass: on', 'Error code: 5'])('keeps prose %s', (body) => {
    expect(redactText(body)).toBe(body);
  });

  it.each(['password: hunter2', 'X-Api-Key: abc', '{password: abc', 'a=1; token: abc', '"accessToken": abc,'])('withholds %s', (body) => {
    expect(redactText(body)).toBe('[unparsed body redacted]');
  });

  it('redacts name=value pairs by word', () => {
    expect(redactText('monkey=1&token=abc&accessToken=def&spin=2')).toBe('monkey=1&token=…&accessToken=…&spin=2');
  });
});

describe('request helpers', () => {
  it('redacts api key headers in any case', () => {
    expect(redactHeaders({ 'x-api-key': 'a', 'X-Api-Key': 'b', Accept: 'c' })).toEqual({ 'x-api-key': '…', accept: 'c' });
  });
  it('keeps harmless query keys', () => {
    expect(redactUrl('https://a/x?passed=1&keyword=k&token=t')).toBe('https://a/x?passed=1&keyword=k&token=…');
  });
});
