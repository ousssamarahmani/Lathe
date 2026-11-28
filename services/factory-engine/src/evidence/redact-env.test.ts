import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REDACTED, redactString, redactValue } from './redact.js';

// Fake values are built by concatenation so secret scanners stay quiet.
const v = (s: string): string => 'zq' + s + 'Xv9';
const SECRET = v('plantedvalue');

describe('redaction of env-style secrets (review probes)', () => {
  it.each([
    ['LATHE_DB_APP_PASSWORD=' + SECRET],
    ['LATHE_TEST_PASSWORD=' + SECRET],
    ['BETTER_AUTH_SECRET=' + SECRET],
    ['KIRO_API_KEY=' + SECRET],
    ['token=' + SECRET],
    ['lathe.session_token=' + SECRET],
    ['postgres://user:' + SECRET + '@host/db'],
    ['Authorization: Basic ' + Buffer.from('u:' + SECRET).toString('base64')],
    ['Cookie: sid=' + SECRET + '; other=1'],
    ['Set-Cookie: sid=' + SECRET + '; HttpOnly'],
    ['{"password":"' + SECRET + '"}'],
    ['export LATHE_DB_APP_PASSWORD=' + SECRET],
    ['dbPassword: ' + SECRET],
  ])('hides the value in %s', (input) => {
    const out = redactString(input);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(Buffer.from('u:' + SECRET).toString('base64'));
    expect(out).toContain(REDACTED);
  });

  it('keeps the connection string shape and the variable name', () => {
    expect(redactString('postgres://user:' + SECRET + '@host/db')).toBe(
      'postgres://user:' + REDACTED + '@host/db',
    );
    expect(redactString('LATHE_TEST_PASSWORD=' + SECRET)).toBe('LATHE_TEST_PASSWORD=' + REDACTED);
  });

  it('leaves benign words alone', () => {
    for (const s of [
      'tokenizer=fast',
      'keyboard: us',
      'password_policy=strict',
      'password_policy: strict',
      'monkey=banana',
      'user:host@example.com is an address',
    ]) {
      expect(redactString(s)).toBe(s);
    }
  });

  it('is idempotent on the new rules', () => {
    const once = redactString('A_SECRET=' + SECRET + ' postgres://u:' + SECRET + '@h/d');
    expect(redactString(once)).toBe(once);
  });

  it('property: secret-named variables never leak in any text form', () => {
    const name = fc
      .tuple(
        fc.stringMatching(/^[A-Z][A-Z0-9_]{0,12}$/),
        fc.constantFrom('PASSWORD', 'SECRET', 'TOKEN', 'KEY', 'API_KEY'),
      )
      .map(([p, s]) => p + '_' + s);
    const value = fc.stringMatching(/^[A-Za-z0-9]{8,24}$/).map((s) => 'qz' + s);
    fc.assert(
      fc.property(name, value, (n, val) => {
        for (const text of [
          n + '=' + val,
          n + ': ' + val,
          '"' + n.toLowerCase() + '": "' + val + '"',
          'export ' + n + '=' + val,
          'log line ' + n + '=' + val + ' trailing',
        ]) {
          expect(redactString(text)).not.toContain(val);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('property: URL credentials and Cookie values never leak', () => {
    const value = fc.stringMatching(/^[A-Za-z0-9]{8,24}$/).map((s) => 'qz' + s);
    fc.assert(
      fc.property(value, (val) => {
        expect(redactString('postgres://user:' + val + '@host:5432/db')).not.toContain(val);
        expect(redactString('Cookie: a=' + val)).not.toContain(val);
        expect(redactString('Set-Cookie: a=' + val + '; Path=/')).not.toContain(val);
      }),
      { numRuns: 200 },
    );
  });
});

describe('redactValue hides values under secret-named keys', () => {
  it('redacts flat, nested and array values', () => {
    const out = JSON.stringify(
      redactValue({
        dbPassword: SECRET,
        apiKey: SECRET,
        LATHE_TEST_PASSWORD: SECRET,
        authorization: SECRET,
        cookie: SECRET,
        nested: { deep: [{ session_token: SECRET, harmless: 'ok' }] },
        password_policy: 'strict',
      }),
    );
    expect(out).not.toContain(SECRET);
    expect(out).toContain('"harmless":"ok"');
    expect(out).toContain('"password_policy":"strict"');
  });

  it('keeps a __proto__ key as data', () => {
    const out = redactValue(JSON.parse('{"__proto__":{"a":1}}')) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['__proto__']);
  });
});
