const SENSITIVE_NAMES = ['token', 'key', 'secret', 'code', 'otp', 'password', 'pin', 'session', 'auth', 'pwd', 'pass', 'passphrase', 'sid'];
// `name=value` inside free text. A name counts as its own word (`monkey=` and `spin=` do not) or as the tail of a camelCase
// name (`accessToken=`).
export const SENSITIVE = new RegExp(
  `(${SENSITIVE_NAMES.map((n) => `(?<![A-Za-z0-9])(?:${n}|${n.toUpperCase()}|${n[0]!.toUpperCase()}${n.slice(1)})|(?<=[a-z0-9])${n[0]!.toUpperCase()}${n.slice(1)}`).join('|')})(=|%3[dD])[^&#]*`,
  'g',
);

const SECRET_WORDS = new Set([
  'password',
  'passwords',
  'pwd',
  'pass',
  'passphrase',
  'secrets',
  'tok',
  'sid',
  'iban',
  'mnemonic',
  'seed',
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
const SECRET_PAIRS = new Set(['api key', 'card number', 'pin code', 'session token', 'session id', 'private key', 'recovery phrase', 'seed phrase', 'secret phrase']);
const SECRET_WHOLE = new Set(['auth', 'code', 'key', 'session', 'pan', 'apikey', 'x-api-key']);
// Names written as one lowercase word, which keyWords cannot split (`accesstoken`, `sessionid`).
const SECRET_FUSED = new Set([
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'sessiontoken',
  'sessionid',
  'privatekey',
  'secretkey',
  'accesskey',
  'clientsecret',
  'apisecret',
  'pincode',
  'cardnumber',
  'securitycode',
  'verificationcode',
]);

const keyWords = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

// An auth word anywhere in a longer name is a secret's name (`authHeader`); a key is one after these words
// (`sessionKey`, `accessKeyId`, `licenseKey`), not after `item`, `cache` or `sort`.
const SECRET_ANY = new Set(['auth']);
const SECRET_KEY_AFTER = new Set(['session', 'access', 'license', 'encryption', 'private', 'secret', 'signing', 'master', 'client', 'crypto', 'aes', 'hmac', 'ssh', 'gpg', 'pgp', 'account', 'product', 'activation', 'recovery', 'wallet', 'root', 'admin', 'service', 'storage', 'app', 'auth', 'refresh', 'decryption']);
// A code is secret after these words (`authCode`, `inviteCode`), not after `status`, `error`, `country` or `zip`.
const SECRET_CODE_AFTER = new Set(['auth', 'invite', 'invitation', 'verification', 'verify', 'access', 'reset', 'promo', 'otp', 'sms', 'confirmation', 'confirm', 'security', 'recovery', 'activation', 'pairing', 'login', 'mfa', 'totp', 'backup', 'one', 'time']);
// A name that ends in one of these describes a secret, it is not one (`tokenCount`, `passwordLength`, `keyType`).
const ABOUT_A_SECRET = new Set(['count', 'counts', 'length', 'type', 'limit', 'limits', 'usage', 'used']);

// Matches words, so `passed`, `bypass`, `span`, `tokens` and `statusCode` stay readable while `accessToken`,
// `sessionKey`, `authCode` and `X-Api-Key` do not.
export const sensitiveKey = (key: string): boolean => {
  const words = keyWords(key);
  if (SECRET_WHOLE.has(key.toLowerCase()) || SECRET_WHOLE.has(words.join(''))) return true;
  if (SECRET_FUSED.has(words.join(''))) return true;
  if (words.length > 1 && ABOUT_A_SECRET.has(words[words.length - 1]!)) return false;
  return words.some(
    (word, index) =>
      SECRET_WORDS.has(word) ||
      (words.length > 1 && SECRET_ANY.has(word)) ||
      ((word === 'key' || word === 'keys') && index > 0 && SECRET_KEY_AFTER.has(words[index - 1]!)) ||
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
const BEARER_VALUE = /\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/-]{8,}={0,2}/gi;
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

// A string can carry its own secrets: a URL's `?token=`, a form body, or JSON kept as text (a request body logged as a
// prop). JSON text is walked like the value it encodes and written back compact; anything else gets the `name=` rule.
const walkString = (value: string, depth: number, state: Walk): string => {
  const trimmed = value.trimStart();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && depth < 100) {
    try {
      return JSON.stringify(walk(JSON.parse(value), depth + 1, state));
    } catch {
      // Not JSON after all: fall through to the text rules.
    }
  }
  return redactString(value.replace(SENSITIVE, '$1=…'));
};

// A header given as an object, `{ name: 'X-Api-Key', value: '…' }`: the name decides, as a key would.
const headerObject = (value: object): value is { value: unknown } & ({ name: string } | { key: string }) => {
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('value')) return false;
  const name = (value as Record<string, unknown>).name ?? (value as Record<string, unknown>).key;
  return typeof name === 'string' && sensitiveKey(name);
};

const walk = (value: unknown, depth: number, state: Walk): unknown => {
  if (typeof value === 'string') return walkString(value, depth, state);
  if (!value || typeof value !== 'object') return value;
  if (depth >= 100) return '[nested data removed]';
  if (state.path.has(value)) return '[circular]';
  if (++state.nodes > MAX_NODES) return '[truncated]';
  state.path.add(value);
  try {
    // A header list keeps its pairs as [name, value]: the name decides, as an object key would.
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && sensitiveKey(value[0])) return [value[0], '…'];
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, state));
    if (headerObject(value)) return { ...value, value: '…' };
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
