export const REDACTED = '[REDACTED]';
const PRIVATE_KEY_BLOCK = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g;
const BEARER = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const BASIC = /\bBasic\s+[A-Za-z0-9+/]{6,}=*/gi;
const COOKIE_HEADER = /\b((?:Set-)?Cookie)(\s*:\s*)[^\r\n]*/gi;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s/]+(?=@)/gi;
/**
 * Names that end in a secret word, so "DB_APP_PASSWORD", "dbPassword", "api_key" and
 * "lathe.session_token" match while "tokenizer", "keyboard" and "password_policy" do not.
 * `_` is a word character, so the boundary is a character-class lookbehind, not `\b`.
 */
const SECRET_WORD =
  '(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|secret[_-]?key|[_.-]key)';
const NAME = `[A-Za-z0-9_.-]*${SECRET_WORD}`;
const KEY_VALUE = new RegExp(
  `(?<![A-Za-z0-9_.-])(${NAME}["']?)(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s&"',;]+)`,
  'gi',
);
const SECRET_KEY_NAME = new RegExp(
  `^(?:${NAME}|authorization|proxy-authorization|cookie|set-cookie|credentials?)$`,
  'i',
);
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
/** Redact secrets in one string. Pure and idempotent. */
export function redactString(input: string): string {
  return input
    .replace(PRIVATE_KEY_BLOCK, REDACTED)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(BASIC, `Basic ${REDACTED}`)
    .replace(COOKIE_HEADER, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`)
    .replace(URL_CREDENTIALS, `$1${REDACTED}`)
    .replace(KEY_VALUE, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`)
    .replace(GITHUB_TOKEN, REDACTED)
    .replace(AWS_ACCESS_KEY, REDACTED);
}
/** True when an object key names a secret, so its whole value must be hidden. */
export function isSecretKeyName(key: string): boolean {
  return SECRET_KEY_NAME.test(key);
}
/** Redact every string value and object key inside a JSON-compatible value. */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const hide = isSecretKeyName(k) && v !== null && v !== undefined;
      // defineProperty keeps a "__proto__" key as data instead of setting the prototype.
      Object.defineProperty(out, redactString(k), {
        value: hide ? REDACTED : redactValue(v),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}
