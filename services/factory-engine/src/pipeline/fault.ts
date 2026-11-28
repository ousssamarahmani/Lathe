import { FAULT_LABEL, FaultName, Patch, type FaultInjectionRecord } from '@lathe/shared-contracts';
import { sha256Hex, type EvidenceLog } from '../evidence/index.js';

/**
 * Labeled demo fault injection (task P5-05, decision D12).
 *
 * The Engine, not the agent, removes the tenant filter from one KB query after the
 * builder's patch and before verification, so the independent gates have a real
 * bug to catch. It only ever runs on demo runs, on the first build attempt, and
 * it is always recorded as evidence labeled "injected by Lathe".
 */

export type FaultErrorCode = 'fault_not_allowed' | 'unknown_fault' | 'fault_not_applicable';

export class FaultInjectionError extends Error {
  constructor(
    readonly code: FaultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FaultInjectionError';
  }
}

/** What the Engine knows about a run's fault setting (the `runs.demo` and `runs.fault_injection` columns). */
export interface FaultRun {
  readonly demo: boolean;
  readonly faultInjection: string | null;
  /** 0 on the first build attempt; repair attempts are 1 or more. */
  readonly repairAttempts: number;
}

export interface RunFaultSource {
  get(runId: string): Promise<FaultRun>;
}

export interface FaultInjection {
  readonly fault: FaultName;
  readonly label: typeof FAULT_LABEL;
  readonly file: string;
  /** The removed source line, as a small standalone patch. Separate from the agent patch. */
  readonly injectedPatch: string;
  readonly injectedPatchSha256: string;
  readonly agentPatchSha256: string;
}

export type FaultResult =
  | { readonly applied: false; readonly patch: Patch }
  | { readonly applied: true; readonly patch: Patch; readonly injection: FaultInjection };

const KB_PATH = /(^|\/)kb\//;
const TENANT_FILTER_LINE = /^\+\s*eq\(\s*[A-Za-z_$][\w$]*\.orgId\s*,\s*ctx\.orgId\s*\),?\s*$/;
const FILE_HEADER = /^diff --git a\/.+ b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?( @@.*)$/;

interface Located {
  readonly lineIndex: number;
  readonly headerIndex: number;
  readonly fileEndIndex: number;
  readonly file: string;
}

/** First added `eq(<table>.orgId, ctx.orgId)` line inside a KB file that can be dropped safely. */
function locate(lines: readonly string[]): Located | null {
  let file = '';
  let headerIndex = -1;
  let oldLeft = 0;
  let newLeft = 0;
  let newCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (oldLeft > 0 || newLeft > 0) {
      const c = line.charAt(0);
      if (c === '+' && KB_PATH.test(file) && TENANT_FILTER_LINE.test(line) && newCount > 1) {
        let end = i + 1;
        while (end < lines.length && !(lines[end] ?? '').startsWith('diff --git ')) end++;
        return { lineIndex: i, headerIndex, fileEndIndex: end, file };
      }
      if (c === ' ' || line === '') {
        oldLeft--;
        newLeft--;
      } else if (c === '-') oldLeft--;
      else if (c === '+') newLeft--;
      continue;
    }
    const f = FILE_HEADER.exec(line);
    if (f) {
      file = f[1] ?? '';
      continue;
    }
    const h = HUNK_HEADER.exec(line);
    if (h) {
      headerIndex = i;
      oldLeft = Number(h[2] ?? 1);
      newLeft = Number(h[4] ?? 1);
      newCount = newLeft;
    }
  }
  return null;
}

function dropTenantFilter(patch: Patch): { diff: string; file: string; removed: string } | null {
  const lines = patch.diff.split('\n');
  const at = locate(lines);
  if (at === null) return null;
  const removed = (lines[at.lineIndex] ?? '').slice(1).trim();
  const out = lines.slice();
  out.splice(at.lineIndex, 1);
  // Keep the diff well formed: one fewer new-side line in this hunk, and later hunks of the file start one line earlier.
  for (let i = at.headerIndex; i < at.fileEndIndex - 1 && i < out.length; i++) {
    const h = HUNK_HEADER.exec(out[i] ?? '');
    if (!h) continue;
    const start = Number(h[3]) - (i === at.headerIndex ? 0 : 1);
    const count = i === at.headerIndex ? Number(h[4] ?? 1) - 1 : Number(h[4] ?? 1);
    out[i] =
      `@@ -${h[1]}${h[2] === undefined ? '' : `,${h[2]}`} +${String(start)},${String(count)}${h[5]}`;
  }
  return { diff: out.join('\n'), file: at.file, removed };
}

/**
 * Applies the demo fault to the agent's patch. Identity unless the run is a demo
 * run with fault `drop-tenant-filter` on its first attempt. Fails closed: a fault
 * on a non-demo run, an unknown fault, or one that cannot be applied throws.
 */
export function applyFault(run: FaultRun, patch: Patch): FaultResult {
  if (run.faultInjection === null) return { applied: false, patch };
  if (!run.demo)
    throw new FaultInjectionError('fault_not_allowed', 'Fault injection is only for demo runs');
  const name = FaultName.safeParse(run.faultInjection);
  if (!name.success) throw new FaultInjectionError('unknown_fault', 'Unknown fault name');
  if (run.repairAttempts > 0) return { applied: false, patch };

  const dropped = dropTenantFilter(patch);
  if (dropped === null)
    throw new FaultInjectionError(
      'fault_not_applicable',
      'No removable tenant filter found in a KB file of the patch',
    );
  const injectedPatch = `--- a/${dropped.file}\n+++ b/${dropped.file}\n@@ -1 +0,0 @@\n-${dropped.removed}\n`;
  const faulted = Patch.parse({
    baseCommit: patch.baseCommit,
    diff: dropped.diff,
    files: patch.files,
    sha256: sha256Hex(dropped.diff),
  });
  return {
    applied: true,
    patch: faulted,
    injection: {
      fault: name.data,
      label: FAULT_LABEL,
      file: dropped.file,
      injectedPatch,
      injectedPatchSha256: sha256Hex(injectedPatch),
      agentPatchSha256: patch.sha256,
    },
  };
}

/** The record passed to `lathe-verify --fault`. Null unless the run is a demo run with a valid fault. */
export function faultFlagFor(run: FaultRun): FaultInjectionRecord | null {
  if (run.faultInjection === null) return null;
  if (!run.demo)
    throw new FaultInjectionError('fault_not_allowed', 'Fault injection is only for demo runs');
  const name = FaultName.safeParse(run.faultInjection);
  if (!name.success) throw new FaultInjectionError('unknown_fault', 'Unknown fault name');
  return { name: name.data, label: FAULT_LABEL };
}

/** Build-step injector (see `BuildFaultInjector`). Acts on the final cumulative patch only. */
export function createFaultInjector(deps: { faults: RunFaultSource; evidence: EvidenceLog }): {
  afterTask(context: {
    runId: string;
    taskKey: string;
    patch: Patch;
    final: boolean;
  }): Promise<Patch>;
} {
  return {
    async afterTask({ runId, patch, final }) {
      if (!final) return patch;
      const result = applyFault(await deps.faults.get(runId), patch);
      if (!result.applied) return patch;
      const { injection } = result;
      await deps.evidence.append(runId, 'fault_injected', {
        label: injection.label,
        fault: injection.fault,
        file: injection.file,
        injectedPatchSha256: injection.injectedPatchSha256,
        agentPatchSha256: injection.agentPatchSha256,
        resultingPatchSha256: result.patch.sha256,
      });
      return result.patch;
    },
  };
}
