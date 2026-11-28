import { buildEntry, verifyChain, type ChainVerification, type EvidenceEntry } from './chain.js';

export interface EvidenceClock {
  now(): Date;
}

/** Append-only evidence per run. No update or delete operation exists. */
export interface EvidenceLog {
  append(runId: string, kind: string, payload: unknown): Promise<EvidenceEntry>;
  list(runId: string): Promise<readonly EvidenceEntry[]>;
  verify(runId: string): Promise<ChainVerification>;
}

export class InMemoryEvidenceLog implements EvidenceLog {
  private readonly chains = new Map<string, EvidenceEntry[]>();
  constructor(private readonly clock: EvidenceClock) {}

  append(runId: string, kind: string, payload: unknown): Promise<EvidenceEntry> {
    const chain = this.chains.get(runId) ?? [];
    const entry = buildEntry(
      chain[chain.length - 1],
      runId,
      kind,
      payload,
      this.clock.now().toISOString(),
    );
    chain.push(entry);
    this.chains.set(runId, chain);
    return Promise.resolve(entry);
  }

  list(runId: string): Promise<readonly EvidenceEntry[]> {
    return Promise.resolve([...(this.chains.get(runId) ?? [])]);
  }

  async verify(runId: string): Promise<ChainVerification> {
    return verifyChain(await this.list(runId));
  }
}
