/**
 * Diff integrity checks for the static and tests gates (P2-03). They look only at
 * what a patch adds or removes, so an agent cannot make a gate pass by skipping
 * tests, narrowing the test config, or silencing the linter and type checker.
 * Unparseable input fails closed.
 */
import type { Finding } from '@lathe/shared-contracts';
import { gitHeaderPaths, parsePatch, unquote } from './patch-parser.js';

export const INTEGRITY_RULES = {
  focus: 'integrity.focus',
  skip: 'integrity.skip',
  fails: 'integrity.fails',
  testConfig: 'integrity.test-config',
  lintDisable: 'integrity.lint-disable',
  staticScript: 'integrity.static-script',
  unparseable: 'integrity.unparseable',
} as const;

export interface DiffLine {
  /** Line number in the new file (added lines) or the old file (removed lines). */
  readonly line: number;
  readonly text: string;
}
export interface DiffFile {
  /** Path after the change. */
  path: string;
  /** Path before the change (differs from `path` for renames). */
  oldPath: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  readonly added: DiffLine[];
  readonly removed: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function pathField(rest: string): string | null {
  return rest.startsWith('"') ? unquote(rest) : rest;
}

/** Collects added and removed lines per file from `git diff` text. */
export function scanDiff(diff: string): { files: DiffFile[]; problems: string[] } {
  const parsed = parsePatch(diff);
  const files: DiffFile[] = [];
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let cur: DiffFile | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of lines) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = raw.charAt(0);
      if (c === '\\' || cur === null) continue;
      if (c === '-') {
        cur.removed.push({ line: oldNo++, text: raw.slice(1) });
        oldLeft--;
      } else if (c === '+') {
        cur.added.push({ line: newNo++, text: raw.slice(1) });
        newLeft--;
      } else {
        oldNo++;
        newNo++;
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('diff --git ')) {
      const names = gitHeaderPaths(line.slice('diff --git '.length));
      cur = {
        path: names?.[1] ?? '',
        oldPath: names?.[0] ?? '',
        status: 'modified',
        added: [],
        removed: [],
      };
      files.push(cur);
      continue;
    }
    if (cur === null) continue;
    const hunk = HUNK.exec(line);
    if (hunk !== null) {
      oldNo = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newNo = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
    } else if (line.startsWith('new file mode ')) cur.status = 'added';
    else if (line.startsWith('deleted file mode ')) cur.status = 'deleted';
    else if (line.startsWith('rename from '))
      cur.oldPath = pathField(line.slice('rename from '.length)) ?? cur.oldPath;
    else if (line.startsWith('rename to ')) {
      cur.status = 'renamed';
      cur.path = pathField(line.slice('rename to '.length)) ?? cur.path;
    } else if (line.startsWith('+++ b/')) cur.path = pathField(line.slice(6)) ?? cur.path;
  }
  return { files, problems: [...parsed.problems] };
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** Test runner configuration. Includes `vite.config.*` because vitest reads its `test` block. */
const TEST_CONFIG_FILE =
  /^(?:vitest|vite|jest|playwright|mocha|ava)(?:[.-][\w.-]+)?\.(?:config|workspace|setup)\.[cm]?[jt]s$|^\.mocharc(?:\.[\w.]+)?$/;
const TEST_CONFIG_KEY =
  /\b(?:include|exclude|includeSource|threshold|thresholds|coverage|lines|statements|branches|functions|perFile|autoUpdate|enabled|passWithNoTests|allowOnly|bail|retry|testMatch|testRegex|testIgnore|testPathIgnorePatterns|projects|root|dir|skip|only|typecheck|setupFiles|globalSetup|coverageThreshold)\b/;
const TEST_FOCUS =
  /\b(?:it|test|describe|suite|bench)(?:\.[A-Za-z]+)*\.only\b|\b(?:fit|fdescribe|ftest)\s*\(/;
const TEST_SKIP =
  /\b(?:it|test|describe|suite|bench)(?:\.[A-Za-z]+)*\.(?:skip|todo|skipIf|runIf)\b|\b(?:xit|xdescribe|xtest)\s*\(|\b(?:ctx|context)\.skip\s*\(/;
/**
 * `.fails` inverts a test: vitest counts a failing body as passed. Matches the runner chain
 * (`it.concurrent.fails`, `test.fails.each`), bracket access, and any `x.fails(` / `x.fails.` call
 * so tests built with `test.extend` are caught too. Over-matching fails closed.
 */
export const TEST_FAILS =
  /\b(?:it|test|describe|suite|bench)(?:\.[A-Za-z]+)*\.fails\b|\[\s*['"`]fails['"`]\s*\]|\.fails\b(?=\s*[(.`])/;
const LINT_DISABLE = /eslint-disable|@ts-ignore|@ts-nocheck/;
const SCRIPT_LINE = (names: string): RegExp => new RegExp(`^\\s*"(?:${names})[\\w:.-]*"\\s*:`);
const TEST_SCRIPT = SCRIPT_LINE('test|pretest|posttest');
const STATIC_SCRIPT = SCRIPT_LINE('typecheck|lint|build|prebuild|prelint|pretypecheck');
const PACKAGE_JSON_TEST_KEY =
  /^\s*"(?:jest|vitest|coverageThreshold|testMatch|testPathIgnorePatterns)"\s*:/;

const show = (s: string): string => JSON.stringify(s.trim().slice(0, 120));

function finding(rule: string, message: string, path: string, line?: number): Finding {
  const f: Finding = { ruleId: rule, severity: 'high', message: message.slice(0, 2_000) };
  return path !== '' && !path.includes('\\') && !path.startsWith('/')
    ? { ...f, path, ...(line === undefined ? {} : { line }) }
    : f;
}

function unparseable(problems: readonly string[]): Finding[] {
  return problems.map((p) => ({
    ruleId: INTEGRITY_RULES.unparseable,
    severity: 'high' as const,
    message: `patch cannot be parsed safely: ${p}`.slice(0, 2_000),
  }));
}

/** Lint and type-check silencing, and edits to the typecheck, lint and build scripts. */
export function checkStaticIntegrity(diff: string): Finding[] {
  const { files, problems } = scanDiff(diff);
  const out = unparseable(problems);
  for (const f of files) {
    if (CODE_FILE.test(f.path))
      for (const a of f.added)
        if (LINT_DISABLE.test(a.text))
          out.push(
            finding(
              INTEGRITY_RULES.lintDisable,
              `patch adds a lint or type-check suppression: ${show(a.text)}`,
              f.path,
              a.line,
            ),
          );
    if (base(f.path) === 'package.json')
      for (const l of [...f.added, ...f.removed])
        if (STATIC_SCRIPT.test(l.text))
          out.push(
            finding(
              INTEGRITY_RULES.staticScript,
              `patch changes a typecheck, lint or build script: ${show(l.text)}`,
              f.path,
              l.line,
            ),
          );
  }
  return out;
}

/** Focused or skipped tests, and edits that narrow the test configuration or the test script. */
export function checkTestIntegrity(diff: string): Finding[] {
  const { files, problems } = scanDiff(diff);
  const out = unparseable(problems);
  for (const f of files) {
    if (CODE_FILE.test(f.path))
      for (const a of f.added) {
        if (TEST_FOCUS.test(a.text))
          out.push(
            finding(
              INTEGRITY_RULES.focus,
              `patch adds a focused test: ${show(a.text)}`,
              f.path,
              a.line,
            ),
          );
        if (TEST_FAILS.test(a.text))
          out.push(
            finding(
              INTEGRITY_RULES.fails,
              `patch adds an inverted (.fails) test: ${show(a.text)}`,
              f.path,
              a.line,
            ),
          );
        if (TEST_SKIP.test(a.text))
          out.push(
            finding(
              INTEGRITY_RULES.skip,
              `patch adds a skipped or todo test: ${show(a.text)}`,
              f.path,
              a.line,
            ),
          );
      }
    const name = base(f.path);
    if (f.status === 'renamed' && TEST_CONFIG_FILE.test(base(f.oldPath)))
      out.push(
        finding(INTEGRITY_RULES.testConfig, 'patch renames a test configuration file', f.oldPath),
      );
    if (TEST_CONFIG_FILE.test(name)) {
      if (f.status === 'deleted')
        out.push(
          finding(INTEGRITY_RULES.testConfig, 'patch deletes a test configuration file', f.path),
        );
      for (const l of [...f.added, ...f.removed])
        if (TEST_CONFIG_KEY.test(l.text))
          out.push(
            finding(
              INTEGRITY_RULES.testConfig,
              `patch changes test configuration: ${show(l.text)}`,
              f.path,
              l.line,
            ),
          );
    }
    if (name === 'package.json')
      for (const l of [...f.added, ...f.removed])
        if (TEST_SCRIPT.test(l.text) || PACKAGE_JSON_TEST_KEY.test(l.text))
          out.push(
            finding(
              INTEGRITY_RULES.testConfig,
              `patch changes the test script or test configuration: ${show(l.text)}`,
              f.path,
              l.line,
            ),
          );
  }
  return out;
}

/** Scans test sources of the patched tree for `.fails` use, including tests that predate the patch. */
export function checkFailsInSources(files: readonly { path: string; text: string }[]): Finding[] {
  const out: Finding[] = [];
  for (const file of files)
    file.text.split('\n').forEach((text, i) => {
      if (TEST_FAILS.test(text))
        out.push(
          finding(
            INTEGRITY_RULES.fails,
            `test source uses an inverted (.fails) test: ${show(text)}`,
            file.path,
            i + 1,
          ),
        );
    });
  return out;
}
