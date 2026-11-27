import { posix } from 'node:path';
import { KIRO_SESSION_PATH, type SessionRequest } from '@lathe/shared-contracts';
import type { PermissionParams } from './acp-schemas.js';

export type PermissionPolicy = NonNullable<SessionRequest['permissionPolicy']>;

export interface PermissionDecision {
  allowed: boolean;
  /** Policy-terms reason, at most 500 characters. */
  reason: string;
}

const READ_KINDS = new Set(['read', 'search']);
const WRITE_KINDS = new Set(['edit', 'delete', 'move']);

/** Never readable or writable, whatever the policy says. */
const DENIED_ROOTS: readonly string[] = [KIRO_SESSION_PATH, '/proc', '/sys', '/dev', '/etc'];

/** rawInput fields that carry a path (matched case-insensitively). */
const PATH_KEYS = new Set(
  [
    'path',
    'file_path',
    'filePath',
    'destination',
    'target',
    'source',
    'from',
    'to',
    'newPath',
    'oldPath',
    'cwd',
    'directory',
  ].map((k) => k.toLowerCase()),
);
/** Keys whose string values hold commands, not paths, so the "looks absolute" scan skips them. */
const COMMAND_KEYS = new Set(['command', 'cmd', 'args', 'script']);
const MAX_WALK_NODES = 500;
const MAX_WALK_DEPTH = 8;

function normalizeAbs(path: string): string | undefined {
  if (!path.startsWith('/') || path.includes('\0')) return undefined;
  return posix.normalize(path).replace(/\/+$/, '') || '/';
}

/** Segment-wise prefix test: `/workspace/app2` is not under `/workspace/app`. */
function isUnder(path: string, root: string): boolean {
  const r = normalizeAbs(root);
  return r !== undefined && (path === r || path.startsWith(r === '/' ? '/' : r + '/'));
}

interface Collected {
  paths: string[];
  /** A path field held something that is not an absolute path, so it cannot be checked. */
  unresolvable: boolean;
}

/** Collects every path-like value of a tool call's rawInput. Bounded in depth and size. */
function collectRawPaths(raw: unknown, scanValues: boolean): Collected {
  const out: Collected = { paths: [], unresolvable: false };
  let nodes = 0;
  const visit = (value: unknown, key: string | undefined, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_WALK_NODES || depth > MAX_WALK_DEPTH) {
      out.unresolvable = true;
      return;
    }
    const keyed = key !== undefined && PATH_KEYS.has(key.toLowerCase());
    if (typeof value === 'string') {
      const commandish = key !== undefined && COMMAND_KEYS.has(key.toLowerCase());
      if (keyed || (scanValues && !commandish && value.startsWith('/'))) {
        if (value.startsWith('/')) out.paths.push(value);
        else out.unresolvable = true;
      }
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) visit(v, k, depth + 1);
    }
  };
  visit(raw, undefined, 0);
  return out;
}

type PathCheck = { ok: true } | { ok: false; why: string };

function checkPaths(paths: readonly string[], roots: readonly string[]): PathCheck {
  for (const p of paths) {
    const n = normalizeAbs(p);
    if (n === undefined) return { ok: false, why: 'path is not absolute' };
    if (DENIED_ROOTS.some((d) => isUnder(n, d)))
      return { ok: false, why: 'path is in a denied area' };
    if (!roots.some((r) => isUnder(n, r)))
      return { ok: false, why: 'path is outside allowed paths' };
  }
  return { ok: true };
}

/**
 * Decides one `session/request_permission`. Deny by default: no policy, an unknown
 * tool kind, an access without a path, or any path (in `locations` or anywhere in
 * `rawInput`) outside the allowed roots or inside a denied root all reject.
 *
 * `readRoots` are the container paths of the target app and application-foundation
 * mounts. When omitted, reads are limited to `policy.allowWritesUnder`.
 * Symlinks are not resolved here; the sandbox must not contain links that leave the
 * mounts (P4-02).
 */
export function decidePermission(
  policy: PermissionPolicy | undefined,
  toolCall: PermissionParams['toolCall'],
  readRoots?: readonly string[],
): PermissionDecision {
  if (!policy) return { allowed: false, reason: 'no permission policy: reject all' };
  const kind = toolCall.kind ?? 'other';
  const isRead = READ_KINDS.has(kind);
  const isWrite = WRITE_KINDS.has(kind);
  const isThink = kind === 'think';
  const isExecute = kind === 'execute';
  if (!isRead && !isWrite && !isThink && !isExecute)
    return { allowed: false, reason: `tool kind ${kind.slice(0, 50)} not allowed` };
  if (isExecute && !policy.allowCommands)
    return { allowed: false, reason: 'commands not allowed by policy' };

  const located = toolCall.locations?.map((l) => l.path) ?? [];
  const raw = collectRawPaths(toolCall.rawInput, !isExecute);
  const paths = [...located, ...raw.paths];
  if (raw.unresolvable)
    return { allowed: false, reason: `${kind} names a path that cannot be checked` };
  if (paths.length === 0) {
    if (isThink || isExecute) return { allowed: true, reason: `${kind} allowed` };
    return { allowed: false, reason: `${kind} without a location` };
  }
  const roots =
    isWrite || isExecute
      ? policy.allowWritesUnder
      : [...(readRoots ?? []), ...policy.allowWritesUnder];
  const result = checkPaths(paths, roots);
  if (!result.ok) return { allowed: false, reason: `${kind}: ${result.why}`.slice(0, 500) };
  return { allowed: true, reason: `${kind} under allowed paths` };
}
