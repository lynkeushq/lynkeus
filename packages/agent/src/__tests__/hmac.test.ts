import { createHmac } from 'node:crypto';

import { describe, expect, it } from '@jest/globals';

import { hmacSha256Hex, sameHex } from '../hmac';

describe('hmacSha256Hex', () => {
  it('matches RFC 4231 test case 2', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });

  it('matches node:crypto for short, block-sized, long and non-ASCII keys and messages', () => {
    const keys = ['', 'k', 'x'.repeat(64), 'y'.repeat(65), 'ñandú-🔑', 'a'.repeat(200)];
    const messages = ['', 'm', 'z'.repeat(55), 'z'.repeat(56), 'z'.repeat(64), 'lynkeus/app/s/abc/def', '日本語'.repeat(40)];
    for (const key of keys) for (const message of messages) expect(hmacSha256Hex(key, message)).toBe(createHmac('sha256', key).update(message).digest('hex'));
  });

  it('compares equal-length strings and refuses anything else', () => {
    expect(sameHex('abc', 'abc')).toBe(true);
    expect(sameHex('abd', 'abc')).toBe(false);
    expect(sameHex('ab', 'abc')).toBe(false);
    expect(sameHex(undefined, 'abc')).toBe(false);
  });
});
