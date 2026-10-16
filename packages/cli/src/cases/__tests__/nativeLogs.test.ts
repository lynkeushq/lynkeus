import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseLogcat, parseOsLog } from '../nativeLogs.js';

test('an iOS log line becomes a native line at its instant, React Native’s console left out', () => {
  const line = parseOsLog(JSON.stringify({ timestamp: '2026-10-16 14:55:01.123456-0300', messageType: 'Error', eventMessage: 'nw_connection failed', subsystem: 'com.apple.network' }));
  assert.deepEqual(line, { at: Date.parse('2026-10-16T14:55:01.123-03:00'), level: 'error', source: 'native', text: 'nw_connection failed' });
  assert.equal(parseOsLog(JSON.stringify({ timestamp: '2026-10-16 14:55:01.1-0300', messageType: 'Default', eventMessage: 'hi', subsystem: 'com.facebook.react.log', category: 'javascript' })), undefined);
  assert.equal(parseOsLog('Filtering the log data using …'), undefined);
});

test('an Android line is kept only for the app’s uid, ReactNativeJS left out', () => {
  assert.deepEqual(parseLogcat('  1760637301.123  10123  4521  4533 E OkHttp: timeout', '10123'), { at: 1760637301123, level: 'error', source: 'native', text: 'OkHttp: timeout' });
  assert.equal(parseLogcat('  1760637301.123  10999  4521  4533 E Other: x', '10123'), undefined);
  assert.equal(parseLogcat('  1760637301.123  10123  4521  4533 I ReactNativeJS: hello', '10123'), undefined);
});
