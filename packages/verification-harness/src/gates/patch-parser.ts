/**
 * Minimal parser for `git diff` output. It collects every path and file mode a
 * patch touches and fails closed: anything it does not recognise becomes a
 * problem, which the protected-path gate turns into a failure.
 *
 * Accepted input: plain `git diff` output (git headers, text hunks, binary
 * patches). Not accepted: email-style `format-patch` output and diffs without
 * `a/` and `b/` prefixes.
 */
export interface PatchFile {
  /** Every path the file's headers name, unquoted, without the `a/` or `b/` prefix. */
  readonly paths: readonly string[];
  /** Modes the patch gives the file (`new mode`, `new file mode`). */
  readonly modes: readonly string[];
}

export interface ParsedPatch {
  readonly files: readonly PatchFile[];
  readonly problems: readonly string[];
}

type State =
  'start' | 'header' | 'hunk' | 'after-hunk' | 'binary-start' | 'binary-data' | 'binary-gap';
interface OpenFile {
  paths: string[];
  modes: string[];
  headerOk: boolean;
}

const ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};
const MODE_LINES = ['old mode ', 'new mode ', 'deleted file mode ', 'new file mode '] as const;
const PATH_LINES = ['rename from ', 'rename to ', 'copy from ', 'copy to '] as const;
const IGNORED_LINES = [
  'index ',
  'similarity index ',
  'dissimilarity index ',
  'Binary files ',
] as const;
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
/** Start of a binary block: `literal <size>` or `delta <size>`. */
const BINARY_BLOCK = /^(literal|delta) \d+$/;
/** One line of git's base85 binary data: a length character, then base85 characters. No spaces. */
const BASE85_LINE = /^[A-Za-z][0-9A-Za-z!#$%&()*+\-;<=>?@^_`{|}~]{5,}$/;
/** A binary patch has a forward block and at most one reverse block. */
const MAX_BINARY_BLOCKS = 2;
const encoder = new TextEncoder();

/** Decodes a git C-style quoted path such as `"a/\303\251.txt"`. Returns null when malformed. */
export function unquote(token: string): string | null {
  if (token.length < 2 || !token.startsWith('"') || !token.endsWith('"')) return null;
  const body = token.slice(1, -1);
  const bytes: number[] = [];
  let i = 0;
  while (i < body.length) {
    const ch = String.fromCodePoint(body.codePointAt(i) ?? 0);
    if (ch === '"') return null;
    if (ch !== '\\') {
      bytes.push(...encoder.encode(ch));
      i += ch.length;
      continue;
    }
    const next = body.charAt(i + 1);
    if (next >= '0' && next <= '7') {
      const oct = body.slice(i + 1, i + 4);
      if (!/^[0-7]{3}$/.test(oct)) return null;
      const value = Number.parseInt(oct, 8);
      if (value > 255) return null;
      bytes.push(value);
      i += 4;
      continue;
    }
    const escaped = ESCAPES[next];
    if (escaped === undefined) return null;
    bytes.push(escaped);
    i += 2;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/** A path field: a quoted token, or the raw rest of the line. */
function field(rest: string): string | null {
  return rest.startsWith('"') ? unquote(rest) : rest;
}

function stripPrefix(path: string | null, prefix: 'a/' | 'b/'): string | null {
  return path !== null && path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

function quotedTokenEnd(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === '"') return i;
  }
  return -1;
}

/** Old and new path from the rest of a `diff --git` line, or null when the line is ambiguous. */
export function gitHeaderPaths(rest: string): [string, string] | null {
  let a: string | null;
  let b: string | null;
  if (rest.startsWith('"')) {
    const end = quotedTokenEnd(rest);
    if (end === -1 || rest[end + 1] !== ' ') return null;
    a = unquote(rest.slice(0, end + 1));
    b = field(rest.slice(end + 2));
  } else if (rest.includes(' "')) {
    const q = rest.indexOf(' "');
    a = rest.slice(0, q);
    b = field(rest.slice(q + 1));
  } else {
    const mid = (rest.length - 1) / 2;
    if (Number.isInteger(mid) && rest[mid] === ' ' && rest.slice(2, mid) === rest.slice(mid + 3)) {
      a = rest.slice(0, mid);
      b = rest.slice(mid + 1);
    } else {
      const parts = rest.split(' b/');
      if (parts.length !== 2) return null;
      a = parts[0] ?? null;
      b = parts[1] === undefined ? null : `b/${parts[1]}`;
    }
  }
  const oldPath = stripPrefix(a, 'a/');
  const newPath = stripPrefix(b, 'b/');
  return oldPath === null || newPath === null ? null : [oldPath, newPath];
}

function hunkCounts(line: string): [number, number] | null {
  const m = HUNK.exec(line);
  if (m === null) return null;
  return [m[1] === undefined ? 1 : Number(m[1]), m[2] === undefined ? 1 : Number(m[2])];
}

/** Parses `git diff` text. On the first problem it stops and reports it. */
export function parsePatch(text: string): ParsedPatch {
  const files: PatchFile[] = [];
  const problems: string[] = [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();

  let state = 'start' as State;
  let current = null as OpenFile | null;
  let oldLeft = 0;
  let newLeft = 0;
  let binaryBlocks = 0;

  const done = (): ParsedPatch => ({ files, problems });
  const problem = (lineNo: number, why: string): ParsedPatch => {
    problems.push(`line ${lineNo}: ${why}`);
    return done();
  };
  const closeFile = (): string | null => {
    if (state === 'hunk') return 'a hunk ends before its line count';
    if (state === 'binary-start') return 'a binary patch has no data';
    if (state === 'binary-data') return 'a binary block does not end with a blank line';
    if (current !== null) {
      if (!current.headerOk && current.paths.length === 0)
        return 'cannot tell which file a "diff --git" header names';
      files.push({ paths: [...new Set(current.paths)], modes: [...current.modes] });
    }
    return null;
  };

  for (let n = 0; n < lines.length; n++) {
    const lineNo = n + 1;
    const raw = lines[n] ?? '';
    if (state === 'hunk') {
      const c = raw.charAt(0);
      if (c === '\\') continue;
      if (c === ' ' || raw === '') {
        oldLeft--;
        newLeft--;
      } else if (c === '-') oldLeft--;
      else if (c === '+') newLeft--;
      else return problem(lineNo, 'malformed or truncated hunk');
      if (oldLeft < 0 || newLeft < 0) return problem(lineNo, 'hunk is longer than its header says');
      if (oldLeft === 0 && newLeft === 0) state = 'after-hunk';
      continue;
    }
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('diff --git ')) {
      const why = closeFile();
      if (why !== null) return problem(lineNo, why);
      const names = gitHeaderPaths(line.slice('diff --git '.length));
      current = { paths: names === null ? [] : [...names], modes: [], headerOk: names !== null };
      state = 'header';
      continue;
    }
    // Binary sections are parsed, not skipped: after the blocks only `diff --git`
    // (handled above) or the end of the patch may follow (B's review of #7).
    if (state === 'binary-start' || state === 'binary-gap') {
      if (BINARY_BLOCK.test(line) && binaryBlocks < MAX_BINARY_BLOCKS) {
        binaryBlocks++;
        state = 'binary-data';
        continue;
      }
      return problem(
        lineNo,
        state === 'binary-start'
          ? 'expected "literal" or "delta" after "GIT binary patch"'
          : 'unexpected line after a binary patch',
      );
    }
    if (state === 'binary-data') {
      if (line === '') {
        state = 'binary-gap';
        continue;
      }
      if (BASE85_LINE.test(line)) continue;
      return problem(lineNo, 'malformed binary patch data');
    }
    if (state === 'start') return problem(lineNo, 'not a git diff: expected "diff --git"');
    if (line.startsWith('@@')) {
      const counts = hunkCounts(line);
      if (counts === null) return problem(lineNo, 'malformed hunk header');
      [oldLeft, newLeft] = counts;
      state = oldLeft === 0 && newLeft === 0 ? 'after-hunk' : 'hunk';
      continue;
    }
    if (state === 'after-hunk') {
      if (line.startsWith('\\')) continue;
      return problem(lineNo, 'unexpected line after a hunk');
    }
    if (current === null) return problem(lineNo, 'header line outside a file');
    if (line === 'GIT binary patch') {
      state = 'binary-start';
      binaryBlocks = 0;
      continue;
    }
    const mode = MODE_LINES.find((p) => line.startsWith(p));
    if (mode !== undefined) {
      if (mode === 'new mode ' || mode === 'new file mode ')
        current.modes.push(line.slice(mode.length));
      continue;
    }
    const pathLine = PATH_LINES.find((p) => line.startsWith(p));
    if (pathLine !== undefined) {
      const p = field(line.slice(pathLine.length));
      if (p === null) return problem(lineNo, 'malformed quoted path');
      current.paths.push(p);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const rest = line.slice(4);
      if (rest === '/dev/null') continue;
      const p = stripPrefix(field(rest), line.startsWith('---') ? 'a/' : 'b/');
      if (p === null)
        return problem(lineNo, 'path without an a/ or b/ prefix, or malformed quoting');
      current.paths.push(p);
      continue;
    }
    if (IGNORED_LINES.some((p) => line.startsWith(p))) continue;
    return problem(lineNo, `unrecognised header line ${JSON.stringify(line.slice(0, 80))}`);
  }
  const why = closeFile();
  if (why !== null) problems.push(`end of patch: ${why}`);
  return done();
}
