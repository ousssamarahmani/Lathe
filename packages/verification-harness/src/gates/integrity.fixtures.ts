/**
 * Must-catch fixtures for the diff integrity checks of the static and tests
 * gates (P2-03). Every `fail` fixture must produce its `rule` from its `check`;
 * every `pass` fixture must produce no finding. A bypass found in review gets a
 * fixture here before the fix.
 */
export interface IntegrityFixture {
  readonly name: string;
  readonly check: 'static' | 'tests';
  readonly expect: 'pass' | 'fail';
  readonly rule?: string;
  readonly diff: string;
}

/** A one-hunk modification: one context line, then `removed` and `added` lines. Hunk counts are computed. */
export function edit(path: string, removed: readonly string[], added: readonly string[]): string {
  const body = [' context', ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join(
    '\n',
  );
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${1 + removed.length} +1,${1 + added.length} @@`,
    body,
    '',
  ].join('\n');
}

const TEST = 'apps/support-desk/src/kb/article.test.ts';
const CONFIG = 'apps/support-desk/vitest.config.ts';
const PKG = 'apps/support-desk/package.json';

const deleteConfig = String.raw`diff --git a/apps/support-desk/vitest.config.ts b/apps/support-desk/vitest.config.ts
deleted file mode 100644
index 1111111..0000000
--- a/apps/support-desk/vitest.config.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export default {};
`;
const renameConfig = String.raw`diff --git a/apps/support-desk/vitest.config.ts b/apps/support-desk/vitest.config.bak
similarity index 100%
rename from apps/support-desk/vitest.config.ts
rename to apps/support-desk/vitest.config.bak
`;

export const INTEGRITY_FIXTURES: readonly IntegrityFixture[] = [
  // Static gate
  {
    name: 'static-allow-normal-change',
    check: 'static',
    expect: 'pass',
    diff: edit(
      'apps/support-desk/src/kb/index.ts',
      ['export const a = 1;'],
      ['export const a = 2;'],
    ),
  },
  {
    name: 'static-allow-removing-a-suppression',
    check: 'static',
    expect: 'pass',
    diff: edit('apps/support-desk/src/kb/index.ts', ['// eslint-disable-next-line no-console'], []),
  },
  {
    name: 'static-reject-eslint-disable',
    check: 'static',
    expect: 'fail',
    rule: 'integrity.lint-disable',
    diff: edit('apps/support-desk/src/kb/index.ts', [], ['/* eslint-disable */']),
  },
  {
    name: 'static-reject-eslint-disable-next-line',
    check: 'static',
    expect: 'fail',
    rule: 'integrity.lint-disable',
    diff: edit('apps/support-desk/src/kb/index.ts', [], ['// eslint-disable-next-line no-console']),
  },
  {
    name: 'static-reject-ts-ignore',
    check: 'static',
    expect: 'fail',
    rule: 'integrity.lint-disable',
    diff: edit('apps/support-desk/src/kb/index.tsx', [], ['// @ts-ignore']),
  },
  {
    name: 'static-reject-ts-nocheck',
    check: 'static',
    expect: 'fail',
    rule: 'integrity.lint-disable',
    diff: edit('apps/support-desk/src/kb/index.ts', [], ['// @ts-nocheck']),
  },
  {
    name: 'static-reject-lint-script-weakened',
    check: 'static',
    expect: 'fail',
    rule: 'integrity.static-script',
    diff: edit(PKG, ['    "lint": "eslint ."'], ['    "lint": "echo skipped"']),
  },
  {
    name: 'static-reject-typecheck-script-removed',
    check: 'static',
    expect: 'fail',
    rule: 'integrity.static-script',
    diff: edit(PKG, ['    "typecheck": "tsc -p tsconfig.json",'], []),
  },
  {
    name: 'static-reject-unparseable',
    check: 'static',
    expect: 'fail',
    rule: 'integrity.unparseable',
    diff: 'this is not a git diff\n',
  },
  // Tests gate
  {
    name: 'tests-allow-new-test',
    check: 'tests',
    expect: 'pass',
    diff: edit(TEST, [], ["it('lists articles', () => {});"]),
  },
  {
    name: 'tests-allow-skip-as-a-word',
    check: 'tests',
    expect: 'pass',
    diff: edit(TEST, [], ['const skipped = 1; // only a variable']),
  },
  {
    name: 'tests-allow-removing-a-skip',
    check: 'tests',
    expect: 'pass',
    diff: edit(TEST, ["it.skip('old', () => {});"], ["it('old', () => {});"]),
  },
  {
    name: 'tests-allow-unrelated-config-line',
    check: 'tests',
    expect: 'pass',
    diff: edit(CONFIG, [], ['// shared settings']),
  },
  {
    name: 'tests-reject-it-only',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.focus',
    diff: edit(TEST, [], ["it.only('x', () => {});"]),
  },
  {
    name: 'tests-reject-describe-only',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.focus',
    diff: edit(TEST, [], ["describe.only('x', () => {});"]),
  },
  {
    name: 'tests-reject-concurrent-only',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.focus',
    diff: edit(TEST, [], ["test.concurrent.only('x', async () => {});"]),
  },
  {
    name: 'tests-reject-fit',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.focus',
    diff: edit(TEST, [], ["fit('x', () => {});"]),
  },
  {
    name: 'tests-reject-it-skip',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.skip',
    diff: edit(TEST, [], ["it.skip('x', () => {});"]),
  },
  {
    name: 'tests-reject-describe-skip',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.skip',
    diff: edit(TEST, [], ["describe.skip('x', () => {});"]),
  },
  {
    name: 'tests-reject-it-todo',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.skip',
    diff: edit(TEST, [], ["it.todo('x');"]),
  },
  {
    name: 'tests-reject-skip-if',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.skip',
    diff: edit(TEST, [], ["it.skipIf(true)('x', () => {});"]),
  },
  {
    name: 'tests-reject-xit',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.skip',
    diff: edit(TEST, [], ["xit('x', () => {});"]),
  },
  {
    name: 'tests-reject-context-skip',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.skip',
    diff: edit(TEST, [], ['ctx.skip();']),
  },
  {
    name: 'tests-reject-include-narrowed',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.test-config',
    diff: edit(
      CONFIG,
      ["    include: ['src/**/*.test.ts'],"],
      ["    include: ['src/none.test.ts'],"],
    ),
  },
  {
    name: 'tests-reject-exclude-added',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.test-config',
    diff: edit(CONFIG, [], ["    exclude: ['src/kb/**'],"]),
  },
  {
    name: 'tests-reject-threshold-lowered',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.test-config',
    diff: edit(CONFIG, ['      lines: 80,'], ['      lines: 10,']),
  },
  {
    name: 'tests-reject-pass-with-no-tests',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.test-config',
    diff: edit(CONFIG, [], ['    passWithNoTests: true,']),
  },
  {
    name: 'tests-reject-config-deleted',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.test-config',
    diff: deleteConfig,
  },
  {
    name: 'tests-reject-config-renamed',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.test-config',
    diff: renameConfig,
  },
  {
    name: 'tests-reject-test-script-weakened',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.test-config',
    diff: edit(PKG, ['    "test": "vitest run"'], ['    "test": "echo ok"']),
  },
  {
    name: 'tests-reject-it-fails',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.fails',
    diff: edit(TEST, [], ["it.fails('bug', () => { expect(1).toBe(2); });"]),
  },
  {
    name: 'tests-reject-test-fails',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.fails',
    diff: edit(TEST, [], ["test.fails('bug', () => {});"]),
  },
  {
    name: 'tests-reject-describe-fails',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.fails',
    diff: edit(TEST, [], ["describe.fails('suite', () => {});"]),
  },
  {
    name: 'tests-reject-fails-each',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.fails',
    diff: edit(TEST, [], ['it.fails.each([1, 2])("n %i", () => {});']),
  },
  {
    name: 'tests-reject-concurrent-fails',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.fails',
    diff: edit(TEST, [], ["it.concurrent.fails('x', async () => {});"]),
  },
  {
    name: 'tests-reject-fails-bracket',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.fails',
    diff: edit(TEST, [], ["it['fails']('x', () => {});"]),
  },
  {
    name: 'tests-allow-fails-as-a-word',
    check: 'tests',
    expect: 'pass',
    diff: edit(TEST, [], ['const failsafe = 1; // fails over to a default']),
  },
  {
    name: 'tests-reject-unparseable',
    check: 'tests',
    expect: 'fail',
    rule: 'integrity.unparseable',
    diff: 'this is not a git diff\n',
  },
];
