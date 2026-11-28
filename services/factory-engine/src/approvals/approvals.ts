import { canonicalJson, sha256Hex } from '../evidence/canonical.js';

export interface ApprovalRecord {
  readonly subject: string;
  readonly approver: string;
  readonly contentHash: string;
  readonly approvedAt: string;
}

export type ApprovalCheck =
  | { readonly ok: true; readonly approval: ApprovalRecord }
  | {
      readonly ok: false;
      readonly reason: 'not_approved' | 'stale';
      readonly approvedHash?: string;
    };

export interface ApprovalClock {
  now(): Date;
}

/** SHA-256 of the content: strings as UTF-8, anything else as canonical JSON. */
export function hashContent(content: unknown): string {
  return sha256Hex(typeof content === 'string' ? content : canonicalJson(content));
}

export class ApprovalError extends Error {
  readonly code = 'invalid_approval' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalError';
  }
}

/** Approvals are bound to the hash of the approved content; a changed content is stale. */
export class InMemoryApprovals {
  private readonly records = new Map<string, ApprovalRecord[]>();
  constructor(private readonly clock: ApprovalClock) {}

  approve(subject: string, approver: string, content: unknown): ApprovalRecord {
    if (subject.length === 0 || approver.length === 0) {
      throw new ApprovalError('subject and approver are required');
    }
    const record: ApprovalRecord = Object.freeze({
      subject,
      approver,
      contentHash: hashContent(content),
      approvedAt: this.clock.now().toISOString(),
    });
    const list = this.records.get(subject) ?? [];
    list.push(record);
    this.records.set(subject, list);
    return record;
  }

  /** Passes only if the latest approval of the subject covers exactly the current content. */
  check(subject: string, currentContent: unknown): ApprovalCheck {
    const list = this.records.get(subject);
    const latest = list?.[list.length - 1];
    if (!latest) return { ok: false, reason: 'not_approved' };
    if (latest.contentHash !== hashContent(currentContent)) {
      return { ok: false, reason: 'stale', approvedHash: latest.contentHash };
    }
    return { ok: true, approval: latest };
  }

  history(subject: string): readonly ApprovalRecord[] {
    return [...(this.records.get(subject) ?? [])];
  }
}
