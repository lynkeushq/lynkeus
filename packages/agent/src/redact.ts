const SENSITIVE_NAMES = ['token', 'key', 'secret', 'code', 'otp', 'password', 'pin', 'session', 'auth'];
// `name=value` inside free text. A name counts as its own word (`monkey=` and `spin=` do not) or as the tail of a camelCase
// name (`accessToken=`).
export const SENSITIVE = new RegExp(
  `(${SENSITIVE_NAMES.map((n) => `(?<![A-Za-z0-9])(?:${n}|${n.toUpperCase()}|${n[0]!.toUpperCase()}${n.slice(1)})|(?<=[a-z0-9])${n[0]!.toUpperCase()}${n.slice(1)}`).join('|')})(=|%3[dD])[^&#]*`,
  'g',
);

const SECRET_WORDS = new Set([
  'password',
  'passcode',
  'passwd',
  'pin',
  'otp',
  'secret',
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'jwt',
  'signature',
  'csrf',
  'xsrf',
  'cvv',
  'cvc',
  'ssn',
  'token',
]);
const SECRET_PAIRS = new Set(['api key', 'card number', 'pin code', 'session token', 'session id', 'private key']);
const SECRET_WHOLE = new Set(['auth', 'code', 'key', 'session', 'pan', 'apikey', 'x-api-key']);

const keyWords = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

// A key or auth word anywhere in a longer name is a secret's name (`sessionKey`, `accessKeyId`, `authHeader`).
const SECRET_ANY = new Set(['key', 'keys', 'auth']);
// A code is secret after these words (`authCode`, `inviteCode`), not after `status`, `error`, `country` or `zip`.
const SECRET_CODE_AFTER = new Set(['auth', 'invite', 'invitation', 'verification', 'verify', 'access', 'reset', 'promo', 'otp', 'sms', 'confirmation', 'confirm', 'security', 'recovery', 'activation', 'pairing', 'login', 'mfa', 'totp', 'backup', 'one', 'time']);
// A name that ends in one of these describes a secret, it is not one (`tokenCount`, `passwordLength`, `keyType`).
const ABOUT_A_SECRET = new Set(['count', 'counts', 'length', 'type', 'limit', 'limits', 'usage', 'used']);

// Matches words, so `passed`, `bypass`, `span`, `tokens` and `statusCode` stay readable while `accessToken`,
// `sessionKey`, `authCode` and `X-Api-Key` do not.
export const sensitiveKey = (key: string): boolean => {
  const words = keyWords(key);
  if (SECRET_WHOLE.has(key.toLowerCase()) || SECRET_WHOLE.has(words.join(''))) return true;
  if (words.length > 1 && ABOUT_A_SECRET.has(words[words.length - 1]!)) return false;
  return words.some(
    (word, index) =>
      SECRET_WORDS.has(word) ||
      (words.length > 1 && SECRET_ANY.has(word)) ||
      (word === 'code' && index > 0 && SECRET_CODE_AFTER.has(words[index - 1]!)) ||
      (word === 'session' && index === words.length - 1 && words.length > 1) ||
      (index > 0 && SECRET_PAIRS.has(`${words[index - 1]} ${word}`)),
  );
};

// A key only counts in key position (start of a line, or after `{ , ; &`), so prose like "Waiting for monkey: x" is kept.
const TEXT_KEY = /(?:^|[{,;&])[ \t]*["']?([\w.-]+)["']?[ \t]*:/gm;
const hasSecretKey = (body: string): boolean => {
  for (const match of body.matchAll(TEXT_KEY)) if (sensitiveKey(match[1]!)) return true;
  return false;
};

const JWT_VALUE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
const BEARER_VALUE = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}={0,2}/gi;
const PATH_KEYS = new Set([
  'token',
  'key',
  'keys',
  'secret',
  'secrets',
  'code',
  'codes',
  'otp',
  'password',
  'password-reset',
  'reset-password',
  'pin',
  'session',
  'sessions',
  'credential',
  'credentials',
  'jwt',
  'signature',
  'csrf',
  'xsrf',
]);
const redactPathSecrets = (value: string): string =>
  value
    .split('/')
    .map((part, index, parts) => {
      if (index === 0) return part;
      const [secret = '', suffix = ''] = part.match(/^([^?#]*)(.*)$/)!.slice(1);
      let name: string;
      try {
        name = decodeURIComponent(parts[index - 1]!).toLowerCase();
      } catch {
        return part;
      }
      if (!PATH_KEYS.has(name)) return part;
      if (secret.length >= 12 || ((name === 'otp' || name === 'pin' || name === 'code') && /^\d{4,8}$/.test(secret))) return `…${suffix}`;
      return part;
    })
    .join('/');

export const redactString = (value: string) => redactPathSecrets(value.replace(JWT_VALUE, '…').replace(BEARER_VALUE, '$1…'));

const MAX_NODES = 10_000;
type Walk = { path: WeakSet<object>; nodes: number };

const walk = (value: unknown, depth: number, state: Walk): unknown => {
  if (typeof value === 'string') return redactString(value);
  if (!value || typeof value !== 'object') return value;
  if (depth >= 100) return '[nested data removed]';
  if (state.path.has(value)) return '[circular]';
  if (++state.nodes > MAX_NODES) return '[truncated]';
  state.path.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, state));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey(key) ? '…' : walk(item, depth + 1, state)]));
  } finally {
    state.path.delete(value);
  }
};

export const redactValue = (value: unknown): unknown => walk(value, 0, { path: new WeakSet(), nodes: 0 });

export const redactText = (body: string): string => {
  try {
    return JSON.stringify(redactValue(JSON.parse(body)), null, 2);
  } catch {
    // An unparsed body cannot be walked safely. Do not return malformed JSON or
    // header-like text just because its secret has an unfamiliar shape.
    if (hasSecretKey(body)) return '[unparsed body redacted]';
    return redactString(body.replace(SENSITIVE, '$1=…'));
  }
};
