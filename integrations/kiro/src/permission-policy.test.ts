import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decidePermission, type PermissionPolicy } from './permission-policy.js';

const policy: PermissionPolicy = { allowWritesUnder: ['/workspace/app'], allowCommands: false };
const readRoots = ['/workspace/app', '/workspace/application-foundation'];

type ToolCall = Parameters<typeof decidePermission>[1];

function call(kind: string, paths: string[] = [], rawInput?: unknown): ToolCall {
  return {
    toolCallId: 'tc',
    kind,
    ...(paths.length > 0 ? { locations: paths.map((path) => ({ path })) } : {}),
    ...(rawInput !== undefined ? { rawInput } : {}),
  };
}
const decide = (c: ToolCall) => decidePermission(policy, c, readRoots).allowed;

describe('reads are confined to the read roots', () => {
  it('allows reads under the app and foundation mounts', () => {
    expect(decide(call('read', ['/workspace/app/src/a.ts']))).toBe(true);
    expect(decide(call('search', ['/workspace/application-foundation/src']))).toBe(true);
    expect(decide(call('read', ['/workspace/app']))).toBe(true);
  });
  it('denies the Kiro session token', () => {
    expect(decide(call('read', ['/home/agent/.kiro/token.json']))).toBe(false);
    expect(decide(call('read', ['/home/agent/.kiro']))).toBe(false);
  });
  it('denies /proc, /sys, /dev and /etc', () => {
    for (const p of ['/proc/self/environ', '/sys/kernel', '/dev/null', '/etc/passwd'])
      expect(decide(call('read', [p]))).toBe(false);
  });
  it('denies a read with no locations and no path', () => {
    expect(decide(call('read'))).toBe(false);
    expect(decide(call('search'))).toBe(false);
  });
  it('denies reads that name a path only in rawInput', () => {
    expect(decide(call('read', [], { path: '/proc/self/environ' }))).toBe(false);
    expect(decide(call('read', ['/workspace/app/a.ts'], { file_path: '/etc/shadow' }))).toBe(false);
  });
  it('lets think pass without a path and checks it with one', () => {
    expect(decide(call('think'))).toBe(true);
    expect(decide(call('think', [], { thought: 'plan the change' }))).toBe(true);
    expect(decide(call('think', [], { path: '/home/agent/.kiro/token.json' }))).toBe(false);
    expect(decide(call('think', ['/proc/self/environ']))).toBe(false);
  });
});

describe('writes check locations and every rawInput path', () => {
  it('denies a move whose destination is outside', () => {
    const c = call('move', ['/workspace/app/a.ts'], {
      source: '/workspace/app/a.ts',
      destination: '/home/agent/.kiro/a.ts',
    });
    expect(decide(c)).toBe(false);
  });
  it('denies an edit whose rawInput.path is outside', () => {
    expect(decide(call('edit', ['/workspace/app/a.ts'], { path: '/workspace/other/a.ts' }))).toBe(
      false,
    );
  });
  it('allows a write when every path is inside', () => {
    const c = call('move', ['/workspace/app/a.ts'], {
      from: '/workspace/app/a.ts',
      to: '/workspace/app/b.ts',
    });
    expect(decide(c)).toBe(true);
  });
  it('finds absolute paths in nested objects and arrays', () => {
    expect(decide(call('edit', ['/workspace/app/a.ts'], { ops: [{ x: '/etc/passwd' }] }))).toBe(
      false,
    );
    expect(decide(call('edit', ['/workspace/app/a.ts'], { a: { b: { c: '/proc/1/mem' } } }))).toBe(
      false,
    );
  });
  it('denies a relative path in a path field', () => {
    expect(decide(call('edit', ['/workspace/app/a.ts'], { path: '../a.ts' }))).toBe(false);
  });
  it('denies a write with no path at all', () => {
    expect(decide(call('edit'))).toBe(false);
    expect(decide(call('edit', [], { content: 'x' }))).toBe(false);
  });
  it('checks the cwd of a command and still honours allowCommands', () => {
    const allow: PermissionPolicy = { ...policy, allowCommands: true };
    const run = (rawInput: unknown) =>
      decidePermission(allow, call('execute', [], rawInput), readRoots).allowed;
    expect(run({ command: '/usr/bin/npm test', cwd: '/workspace/app' })).toBe(true);
    expect(run({ command: 'ls', cwd: '/home/agent/.kiro' })).toBe(false);
    expect(decide(call('execute', [], { command: 'ls' }))).toBe(false);
  });
});

describe('path normalization', () => {
  it('treats /workspace/app2 as outside /workspace/app', () => {
    expect(decide(call('edit', ['/workspace/app2/a.ts']))).toBe(false);
    expect(decide(call('read', ['/workspace/app2/a.ts']))).toBe(false);
  });
  it('resolves .. before checking', () => {
    expect(decide(call('edit', ['/workspace/app/../../home/agent/.kiro/token.json']))).toBe(false);
    expect(decide(call('read', ['/workspace/app/../../etc/passwd']))).toBe(false);
    expect(decide(call('edit', ['/workspace/app/src/../a.ts']))).toBe(true);
  });
  it('collapses duplicate and trailing slashes', () => {
    expect(decide(call('read', ['/workspace//app///a.ts']))).toBe(true);
    expect(decide(call('read', ['/workspace/app/']))).toBe(true);
    expect(decide(call('read', ['//home/agent/.kiro//token.json']))).toBe(false);
    expect(decide(call('read', ['/proc//self/environ']))).toBe(false);
  });
});

describe('property: decisions follow the roots', () => {
  const segment = fc.constantFrom(
    'app',
    'app2',
    'application-foundation',
    'src',
    'a.ts',
    '..',
    '.',
    '',
    'etc',
    'proc',
    'home',
    'agent',
    '.kiro',
    'workspace',
    'dev',
    'sys',
  );
  const absPath = fc
    .array(segment, { minLength: 0, maxLength: 7 })
    .map((s) => '/' + s.join('/'))
    .filter((p) => p.length < 200);
  const pathKey = fc.constantFrom('path', 'destination', 'target', 'cwd', 'from', 'to');
  const kind = fc.constantFrom('read', 'search', 'think', 'edit', 'delete', 'move');
  const request = fc.record({
    kind,
    locations: fc.array(absPath, { maxLength: 3 }),
    raw: fc.array(fc.tuple(pathKey, absPath), { maxLength: 3 }),
  });

  const norm = (p: string): string => {
    const out: string[] = [];
    for (const s of p.split('/')) {
      if (s === '' || s === '.') continue;
      if (s === '..') out.pop();
      else out.push(s);
    }
    return '/' + out.join('/');
  };
  const under = (p: string, root: string): boolean => p === root || p.startsWith(root + '/');
  const denied = ['/home/agent/.kiro', '/proc', '/sys', '/dev', '/etc'];

  it('rejects whenever any path is outside the roots or inside a denied root', () => {
    fc.assert(
      fc.property(request, (r) => {
        const rawInput = Object.fromEntries(r.raw);
        const c = call(r.kind, r.locations, r.raw.length > 0 ? rawInput : undefined);
        const all = [...r.locations, ...r.raw.map(([, p]) => p)].map(norm);
        const roots =
          r.kind === 'edit' || r.kind === 'delete' || r.kind === 'move'
            ? policy.allowWritesUnder
            : readRoots;
        const bad = all.some(
          (p) => denied.some((d) => under(p, d)) || !roots.some((root) => under(p, root)),
        );
        const allowed = decidePermission(policy, c, readRoots).allowed;
        if (bad) expect(allowed).toBe(false);
        // Anything allowed must have at least one path, except think.
        if (allowed && r.kind !== 'think') expect(all.length).toBeGreaterThan(0);
        if (!bad && all.length > 0) expect(allowed).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
