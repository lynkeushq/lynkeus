export const SENSITIVE = /(token|key|secret|code|otp|password|pin|session|auth)(=|%3d)[^&#]*/gi;

const SECRET_KEY =
  /pass(word|code)?|^pin$|pin_?code|otp|^code$|token|secret|authorization|cookie|session|credential|jwt|signature|csrf|xsrf|cvv|cvc|card_?number|pan$|ssn|api_?key|^key$/i;
const SECRET_TEXT =
  /["']?(?:pass(?:word|code)?|pin(?:_?code)?|otp|code|token|secret|authorization|cookie|session|credential|jwt|signature|csrf|xsrf|cvv|cvc|card_?number|pan|ssn|api_?key|key)["']?\s*:\s*/i;

export const sensitiveKey = (key: string): boolean => SECRET_KEY.test(key);

export const redactValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey(key) ? '…' : redactValue(item)]));
  return value;
};

export const redactText = (body: string): string => {
  try {
    return JSON.stringify(redactValue(JSON.parse(body)), null, 2);
  } catch {
    // An unparsed body cannot be walked safely. Do not return malformed JSON or
    // header-like text just because its secret has an unfamiliar shape.
    if (SECRET_TEXT.test(body)) return '[unparsed body redacted]';
    return body.replace(SENSITIVE, '$1=…');
  }
};
