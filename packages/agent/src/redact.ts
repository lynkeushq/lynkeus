export const SENSITIVE = /(token|key|secret|code|otp|password|pin|session|auth)(=|%3d)[^&#]*/gi;

const SECRET_KEY =
  /pass(word|code)?|^pin$|pin_?code|otp|^code$|token|secret|authorization|cookie|session|credential|jwt|signature|csrf|xsrf|cvv|cvc|card_?number|pan$|ssn|api_?key|^key$/i;
const SECRET_TEXT =
  /["']?(?:pass(?:word|code)?|pin(?:_?code)?|otp|code|token|secret|authorization|cookie|session|credential|jwt|signature|csrf|xsrf|cvv|cvc|card_?number|pan|ssn|api_?key|key)["']?\s*:\s*/i;

const JWT_VALUE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
const BEARER_VALUE = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}={0,2}/gi;
const PATH_KEYS = new Set(['token', 'key', 'keys', 'secret', 'secrets', 'code', 'codes', 'otp', 'password', 'password-reset', 'reset-password', 'pin', 'session', 'sessions', 'credential', 'credentials', 'jwt', 'signature', 'csrf', 'xsrf']);
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

export const sensitiveKey = (key: string): boolean => SECRET_KEY.test(key);

export const redactValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey(key) ? '…' : redactValue(item)]));
  if (typeof value === 'string') return redactString(value);
  return value;
};

export const redactText = (body: string): string => {
  try {
    return JSON.stringify(redactValue(JSON.parse(body)), null, 2);
  } catch {
    // An unparsed body cannot be walked safely. Do not return malformed JSON or
    // header-like text just because its secret has an unfamiliar shape.
    if (SECRET_TEXT.test(body)) return '[unparsed body redacted]';
    return redactString(body.replace(SENSITIVE, '$1=…'));
  }
};
