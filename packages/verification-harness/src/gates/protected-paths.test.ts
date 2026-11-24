import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { unquote } from './patch-parser.js';
import { FIXTURES } from './protected-paths.fixtures.js';
import { RULES, checkPatch, foldPath, loadPolicy, protectedPathsGate } from './protected-paths.js';

const POLICY_FILE = fileURLToPath(new URL('../../policies/protected-paths.json', import.meta.url));
const policy = await loadPolicy(POLICY_FILE);
const ctx = (patch: string | null) => ({
  app: 'support-desk',
  worktree: '/workspace/app',
  commit: 'a'.repeat(40),
  faultInjection: null,
  patch,
});

describe('protected-path fixtures (must catch)', () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))('%s', (_name, f) => {
    const rules = checkPatch(f.diff, policy).map((x) => x.ruleId);
    if (f.expect === 'pass') expect(rules).toEqual([]);
    else expect(rules).toContain(f.rule);
  });

  it('covers every rule with at least one fixture', () => {
    const covered = new Set(FIXTURES.map((f) => f.rule));
    for (const rule of [
      RULES.protected,
      RULES.traversal,
      RULES.invalid,
      RULES.symlink,
      RULES.submodule,
      RULES.unparseable,
    ])
      expect(covered.has(rule)).toBe(true);
  });
});

describe('policy', () => {
  it('protects the harness itself, CI and the contracts', () => {
    expect(policy.protected).toEqual(
      expect.arrayContaining([
        'packages/verification-harness/',
        '.github/',
        'packages/shared-contracts/',
      ]),
    );
    expect(policy.rejectSymlinks).toBe(true);
  });
});

describe('helpers', () => {
  it('folds case, trailing dots and compatibility forms', () => {
    expect(foldPath('.GitHub./Workflows ')).toBe('.github/workflows');
  });
  it('decodes git quoting and rejects malformed tokens', () => {
    expect(unquote(String.raw`"a/\303\251.txt"`)).toBe('a/é.txt');
    expect(unquote(String.raw`"a/\q"`)).toBeNull();
    expect(unquote(String.raw`"a/\377"`)).toBeNull();
  });
});

describe('protectedPathsGate', () => {
  const gate = protectedPathsGate(POLICY_FILE);
  const diffOf = (name: string): string => FIXTURES.find((f) => f.name === name)?.diff ?? '';

  it('passes a clean patch and fails a protected one', async () => {
    expect((await gate.run(ctx(diffOf('allow-modify')))).status).toBe('passed');
    const bad = await gate.run(ctx(diffOf('reject-workflow')));
    expect(bad.status).toBe('failed');
    expect(bad.findings[0]?.path).toBe('.github/workflows/ci.yml');
  });
  it('reports error without a patch or with an unreadable policy', async () => {
    expect((await gate.run(ctx(null))).status).toBe('error');
    const broken = protectedPathsGate(
      fileURLToPath(new URL('./missing-policy.json', import.meta.url)),
    );
    expect((await broken.run(ctx(''))).status).toBe('error');
  });
});
