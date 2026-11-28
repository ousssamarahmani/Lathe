import { canonicalJson, sha256Hex } from './canonical.js';
import { redactValue } from './redact.js';

export const GENESIS_HASH = '0'.repeat(64);

export interface EvidenceEntry {
  readonly runId: string;
  readonly seq: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly at: string;
  readonly prevHash: string;
  readonly hash: string;
}

export type ChainVerification =
  | { readonly ok: true; readonly length: number; readonly head: string }
  | { readonly ok: false; readonly index: number; readonly reason: ChainFailure };

export type ChainFailure =
  'bad_sequence' | 'bad_prev_hash' | 'bad_hash' | 'wrong_run' | 'truncated' | 'head_mismatch';

export function computeEntryHash(
  e: Pick<EvidenceEntry, 'runId' | 'seq' | 'kind' | 'payload' | 'at' | 'prevHash'>,
): string {
  const body = canonicalJson({
    runId: e.runId,
    seq: e.seq,
    kind: e.kind,
    payload: e.payload,
    at: e.at,
  });
  return sha256Hex(`${e.prevHash}\n${body}`);
}

/** Build the next entry. Payload is redacted here, before it is hashed or stored. */
export function buildEntry(
  prev: EvidenceEntry | undefined,
  runId: string,
  kind: string,
  payload: unknown,
  at: string,
): EvidenceEntry {
  const base = {
    runId,
    seq: prev ? prev.seq + 1 : 0,
    kind,
    payload: redactValue(payload),
    at,
    prevHash: prev ? prev.hash : GENESIS_HASH,
  };
  return Object.freeze({ ...base, hash: computeEntryHash(base) });
}

/**
 * Verify one run's chain. Detects edits, reordering and deletion inside the chain.
 * Deleting trailing entries is only detectable with `expected` (head hash and/or length
 * recorded elsewhere, for example on the run row).
 */
export function verifyChain(
  entries: readonly EvidenceEntry[],
  expected?: { readonly head?: string; readonly length?: number },
): ChainVerification {
  let prevHash = GENESIS_HASH;
  const runId = entries[0]?.runId;
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (!e) return { ok: false, index: i, reason: 'truncated' };
    if (e.runId !== runId) return { ok: false, index: i, reason: 'wrong_run' };
    if (e.seq !== i) return { ok: false, index: i, reason: 'bad_sequence' };
    if (e.prevHash !== prevHash) return { ok: false, index: i, reason: 'bad_prev_hash' };
    if (computeEntryHash(e) !== e.hash) return { ok: false, index: i, reason: 'bad_hash' };
    prevHash = e.hash;
  }
  if (expected?.length !== undefined && expected.length !== entries.length) {
    return { ok: false, index: entries.length, reason: 'truncated' };
  }
  if (expected?.head !== undefined && expected.head !== prevHash) {
    return { ok: false, index: entries.length, reason: 'head_mismatch' };
  }
  return { ok: true, length: entries.length, head: prevHash };
}
