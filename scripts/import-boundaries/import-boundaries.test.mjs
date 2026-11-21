// Fixture tests for the import-boundary rules (task P0-10). Each rule in
// .dependency-cruiser.mjs must fire on a planted violation, and the clean tree
// and the real repository must pass. A rule that can never fire is a defect.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../../.dependency-cruiser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const script = join(repo, 'scripts', 'check-import-boundaries.mjs');

function check(cwd, extra = []) {
  const args = [script, ...(cwd ? ['--cwd', cwd] : []), ...(extra.length ? ['--', ...extra] : [])];
  return spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8' });
}

function violations(cwd) {
  const result = check(cwd, ['--output-type', 'json']);
  expect(result.error).toBeUndefined();
  return JSON.parse(result.stdout).summary.violations.map(
    (v) => `${v.rule.name} | ${v.from} -> ${v.to}`,
  );
}

/** Every planted violation, and nothing else. */
const EXPECTED = [
  'app-not-other-app | apps/support-desk/src/imports-other-app.ts -> apps/team-operations/src/index.ts',
  'apps-no-lathe | apps/support-desk/src/imports-engine.ts -> services/factory-engine/src/index.ts',
  'contracts-no-first-party | packages/shared-contracts/src/imports-foundation.ts -> packages/application-foundation/src/index.ts',
  'contracts-zod-only | packages/shared-contracts/src/imports-node.ts -> fs',
  'engine-integrations-only-in-main | services/factory-engine/src/pipeline.ts -> integrations/kiro/src/index.ts',
  'engine-no-apps | services/factory-engine/src/imports-app.ts -> apps/support-desk/src/index.ts',
  'foundation-no-lathe | packages/application-foundation/src/imports-engine.ts -> services/factory-engine/src/index.ts',
  'foundation-no-lathe | packages/application-foundation/src/imports-kiro.ts -> integrations/kiro/src/index.ts',
  'harness-only-contracts | packages/verification-harness/src/imports-foundation.ts -> packages/application-foundation/src/index.ts',
  'integration-only-contracts | integrations/github/src/imports-engine.ts -> services/factory-engine/src/index.ts',
  'integration-only-contracts | integrations/kiro/src/imports-github.ts -> integrations/github/src/index.ts',
  'nobody-else-imports-integrations | packages/application-foundation/src/imports-kiro.ts -> integrations/kiro/src/index.ts',
  'nobody-imports-harness | packages/application-foundation/src/imports-harness.ts -> packages/verification-harness/src/index.ts',
  'no-circular | packages/application-foundation/src/cycle-a.ts -> packages/application-foundation/src/cycle-b.ts',
  'no-unresolvable | packages/application-foundation/src/imports-missing.ts -> ./missing.js',
  'only-through-index | apps/support-desk/src/imports-deep.ts -> packages/application-foundation/src/internal.ts',
  'workspace-no-db | apps/workspace/src/imports-pg.ts -> pg',
  'workspace-only-contracts | apps/workspace/src/imports-foundation.ts -> packages/application-foundation/src/index.ts',
];

describe('import boundaries', () => {
  it('reports exactly the planted violations', () => {
    expect(violations(join(here, 'fixtures', 'violations')).sort()).toEqual([...EXPECTED].sort());
  });

  it('has a planted violation for every rule', () => {
    const fired = new Set(EXPECTED.map((line) => line.split(' | ')[0]));
    expect(config.forbidden.map((rule) => rule.name).filter((name) => !fired.has(name))).toEqual(
      [],
    );
  });

  it('fails the lint step on violations', () => {
    const result = check(join(here, 'fixtures', 'violations'));
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('dependency violations');
  });

  it('passes every allowed import in the dependency table', () => {
    const result = check(join(here, 'fixtures', 'clean'));
    expect(result.stdout).toContain('no dependency violations found');
    expect(result.status).toBe(0);
  });

  it('passes on the repository itself', () => {
    const result = check(null);
    expect(result.stdout).toContain('no dependency violations found');
    expect(result.status).toBe(0);
  });
});
