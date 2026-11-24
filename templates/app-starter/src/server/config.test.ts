import { describe, expect, it } from 'vitest';
import { APP_SLUG } from './app-slug';
import { authz } from './authz';
import { readAppEnv, readOwnerEnv } from './env';
import { demoSeed, SEED_ORGS, SEED_PRINCIPALS } from './seed-data';

const valid = {
  POSTGRES_DB: 'lathe',
  LATHE_DB_APP_ROLE: 'lathe_app',
  LATHE_DB_APP_PASSWORD: 'app-password-value',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
};

describe('environment', () => {
  it('parses a valid app environment with defaults', () => {
    const env = readAppEnv(valid);
    expect(env.POSTGRES_PORT).toBe(5432);
    expect(env.LATHE_APP_BASE_URL).toBe('http://localhost:3000');
  });

  it('names missing or invalid variables without printing any value', () => {
    const secret = 'short-secret-value';
    const bad = { ...valid, BETTER_AUTH_SECRET: secret, LATHE_DB_APP_PASSWORD: undefined };
    expect(() => readAppEnv(bad)).toThrowError(
      /BETTER_AUTH_SECRET.*LATHE_DB_APP_PASSWORD|LATHE_DB_APP_PASSWORD.*BETTER_AUTH_SECRET/,
    );
    try {
      readAppEnv(bad);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('uses its own database, not the foundation one, unless LATHE_APP_DB overrides it', () => {
    expect(readAppEnv(valid).database).toBe(`lathe_${APP_SLUG.replaceAll('-', '_')}`);
    expect(readAppEnv({ ...valid, LATHE_APP_DB: 'custom_db' }).database).toBe('custom_db');
    expect(() => readAppEnv({ ...valid, LATHE_APP_DB: 'x; DROP DATABASE lathe' })).toThrowError(
      /LATHE_APP_DB/,
    );
  });

  it('the app environment never needs the owner role', () => {
    expect(() => readAppEnv(valid)).not.toThrow();
    expect(() => readOwnerEnv(valid)).toThrowError(/LATHE_DB_OWNER_ROLE/);
  });
});

describe('roles', () => {
  it('only the owner can invite or manage members', () => {
    for (const role of authz.roles) {
      const p = authz.permissionsOf(role);
      const manages = p.includes('members.invite') || p.includes('members.manage');
      expect(manages).toBe(role === 'owner');
    }
  });

  it('every role can read and leave, and the viewer cannot write notes', () => {
    for (const role of authz.roles) {
      expect(authz.permissionsOf(role)).toEqual(
        expect.arrayContaining(['notes.read', 'notes.list', 'members.read', 'members.leave']),
      );
    }
    expect(
      authz.permissionsOf('viewer').some((p) => /^notes\.(create|update|delete)$/.test(p)),
    ).toBe(false);
  });
});

describe('seed data', () => {
  it('has one principal per role in org a and in org b, on a .test domain', () => {
    for (const org of ['a', 'b'] as const) {
      const roles = SEED_PRINCIPALS.filter((p) => p.org === org).map((p) => p.role);
      expect([...roles].sort()).toEqual([...authz.roles].sort());
    }
    for (const p of SEED_PRINCIPALS) expect(p.email).toMatch(/@app-starter-org-[ab]\.test$/);
    expect(new Set(SEED_PRINCIPALS.map((p) => p.email)).size).toBe(SEED_PRINCIPALS.length);
  });

  it('takes the password from the caller and puts each user in exactly one org', () => {
    const seed = demoSeed('from-the-environment');
    expect(seed.password).toBe('from-the-environment');
    expect(Object.keys(seed.orgs).sort()).toEqual(['a', 'b']);
    expect(SEED_ORGS.a.id).not.toBe(SEED_ORGS.b.id);
    for (const u of seed.users) expect(u.memberOf).toHaveLength(1);
  });
});
