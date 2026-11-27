/**
 * Fake ACP agent for tests. Speaks newline-delimited JSON-RPC over in-memory streams,
 * so the adapter can be tested without `kiro-cli`, a login, or a container.
 *
 * Two modes:
 *  - `FakeAcpServer`: scripted behaviour (steps for a prompt turn, failures, hangs).
 *  - `ReplayAcpServer`: replays a recorded transcript (`fixtures/transcripts/*.jsonl`).
 *
 * Test code only. Nothing in `src/index.ts` exports it as part of the adapter.
 */
import { PassThrough } from 'node:stream';
import type { AcpProcess, ExitInfo, SpawnFn } from '../process.js';

type Json = Record<string, unknown>;

abstract class FakeBase {
  protected readonly toServer = new PassThrough();
  protected readonly fromServer = new PassThrough();
  protected exitListeners: Array<(info: ExitInfo) => void> = [];
  protected exitInfo: ExitInfo | undefined;
  private buffer = '';
  /** Every parsed message the client sent, in order. */
  readonly received: Json[] = [];
  killCount = 0;

  constructor() {
    this.toServer.setEncoding('utf8');
    this.toServer.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const nl = this.buffer.indexOf('\n');
        if (nl < 0) break;
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim() === '') continue;
        const msg = JSON.parse(line) as Json;
        this.received.push(msg);
        this.onClientMessage(msg);
      }
    });
  }

  protected abstract onClientMessage(msg: Json): void;

  /** The process handle to hand to the adapter. */
  readonly process: AcpProcess = {
    stdin: this.toServer,
    stdout: this.fromServer,
    kill: () => {
      this.killCount += 1;
      this.exit(null, 'SIGTERM');
    },
    onExit: (listener) => {
      this.exitListeners.push(listener);
      if (this.exitInfo) listener(this.exitInfo);
    },
  };

  /** A `SpawnFn` that returns this server. */
  asSpawn(): SpawnFn {
    return () => this.process;
  }

  protected send(msg: Json): void {
    this.fromServer.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  }

  protected sendRaw(line: string): void {
    this.fromServer.write(line + '\n');
  }

  exit(code: number | null, signal: string | null = null): void {
    if (this.exitInfo) return;
    this.exitInfo = { code, signal };
    this.fromServer.end();
    const info = this.exitInfo;
    // Deliver after stdout had a chance to flush, like a real child process.
    setImmediate(() => {
      for (const l of this.exitListeners) l(info);
    });
  }
}

export type FakeStep =
  | { do: 'update'; update: Json }
  | { do: 'permission'; toolCall: Json; options?: Json[] }
  | { do: 'raw'; line: string }
  | { do: 'wait'; ms: number }
  | { do: 'exit'; code: number }
  | { do: 'hang' }
  | { do: 'end'; stopReason: string };

export interface FakeScript {
  sessionId?: string;
  /** Answer `session/new` with the "Not logged in" error seen in the spike. */
  authRequired?: boolean;
  /** Never answer this method. */
  hangOn?: 'initialize' | 'session/new';
  /** Never end a cancelled turn. */
  ignoreCancel?: boolean;
  /** Steps run for each `session/prompt`. An implicit `end_turn` follows unless one step ends the turn. */
  promptSteps?: FakeStep[];
}

export class FakeAcpServer extends FakeBase {
  /** Answers to `session/request_permission`, as the client sent them. */
  readonly permissionReplies: unknown[] = [];
  private cancelWake: (() => void) | undefined;
  private cancelled = false;
  private permissionWaiters = new Map<number, (reply: unknown) => void>();
  private nextRequestId = 9000;

  constructor(private readonly script: FakeScript = {}) {
    super();
  }

  protected onClientMessage(msg: Json): void {
    const method = msg['method'];
    const id = msg['id'];
    if (method === undefined && typeof id === 'number') {
      const waiter = this.permissionWaiters.get(id);
      if (waiter) {
        this.permissionWaiters.delete(id);
        this.permissionReplies.push(msg['result']);
        waiter(msg['result']);
      }
      return;
    }
    if (method === 'initialize') {
      if (this.script.hangOn === 'initialize') return;
      this.send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [{ id: 'aws-builder-id' }],
        },
      });
    } else if (method === 'session/new') {
      if (this.script.hangOn === 'session/new') return;
      if (this.script.authRequired) {
        this.send({
          id,
          error: {
            code: -32000,
            message: 'Authentication required. Not logged in. Run kiro-cli login first',
          },
        });
        return;
      }
      this.send({ id, result: { sessionId: this.script.sessionId ?? 'sess-fake-1' } });
    } else if (method === 'session/prompt') {
      void this.runPrompt(id);
    } else if (method === 'session/cancel') {
      this.cancelled = true;
      if (!this.script.ignoreCancel) this.cancelWake?.();
    }
  }

  private sleepOrCancel(ms: number | undefined): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = ms === undefined ? undefined : setTimeout(resolve, ms);
      this.cancelWake = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
    });
  }

  private async runPrompt(id: unknown): Promise<void> {
    this.cancelled = false;
    const sessionId = this.script.sessionId ?? 'sess-fake-1';
    for (const step of this.script.promptSteps ?? []) {
      if (this.exitInfo) return;
      switch (step.do) {
        case 'update':
          this.send({ method: 'session/update', params: { sessionId, update: step.update } });
          break;
        case 'raw':
          this.sendRaw(step.line);
          break;
        case 'permission': {
          const reqId = this.nextRequestId++;
          const reply = new Promise<unknown>((resolve) =>
            this.permissionWaiters.set(reqId, resolve),
          );
          this.send({
            id: reqId,
            method: 'session/request_permission',
            params: {
              sessionId,
              toolCall: step.toolCall,
              options: step.options ?? [
                { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
                { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
              ],
            },
          });
          await reply;
          break;
        }
        case 'wait':
          await this.sleepOrCancel(step.ms);
          break;
        case 'hang':
          await this.sleepOrCancel(undefined);
          break;
        case 'exit':
          this.exit(step.code);
          return;
        case 'end':
          this.send({ id, result: { stopReason: step.stopReason } });
          return;
      }
      if (this.cancelled && !this.script.ignoreCancel) {
        this.send({ id, result: { stopReason: 'cancelled' } });
        return;
      }
    }
    if (this.cancelled && this.script.ignoreCancel) return;
    this.send({ id, result: { stopReason: this.cancelled ? 'cancelled' : 'end_turn' } });
  }
}

/** One line of a recorded transcript. `replyTo` names the client request an `out` response answers. */
export interface TranscriptEntry {
  dir: 'in' | 'out';
  replyTo?: string;
  msg: Json;
}

export function parseTranscript(text: string): TranscriptEntry[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as TranscriptEntry);
}

/**
 * Replays a transcript. `out` entries are sent by the server as soon as every earlier
 * `in` entry arrived. A client message that does not match the next `in` entry (method,
 * or for replies the presence of a result) is recorded in `mismatches`.
 */
export class ReplayAcpServer extends FakeBase {
  readonly mismatches: string[] = [];
  private index = 0;
  private readonly requestIds = new Map<string, unknown>();

  constructor(private readonly entries: TranscriptEntry[]) {
    super();
    queueMicrotask(() => {
      this.pump();
    });
  }

  get finished(): boolean {
    return this.index >= this.entries.length;
  }

  protected onClientMessage(msg: Json): void {
    const next = this.entries[this.index];
    const method = typeof msg['method'] === 'string' ? msg['method'] : undefined;
    if (!next || next.dir !== 'in') {
      this.mismatches.push(`unexpected client message ${method ?? 'reply'}`);
      return;
    }
    const expected = next.msg['method'];
    if (method !== expected) {
      this.mismatches.push(`expected ${String(expected)}, got ${method ?? 'reply'}`);
      return;
    }
    if (method === undefined) {
      const wantedOutcome = JSON.stringify(next.msg['result']);
      const gotOutcome = JSON.stringify(msg['result']);
      if (wantedOutcome !== gotOutcome)
        this.mismatches.push(`permission reply ${gotOutcome} != recorded ${wantedOutcome}`);
    } else if (msg['id'] !== undefined) {
      this.requestIds.set(method, msg['id']);
    }
    this.index += 1;
    this.pump();
  }

  private pump(): void {
    for (
      let e = this.entries[this.index];
      e !== undefined && e.dir === 'out';
      e = this.entries[this.index]
    ) {
      const msg = { ...e.msg };
      if (e.replyTo !== undefined) msg['id'] = this.requestIds.get(e.replyTo);
      this.send(msg);
      this.index += 1;
    }
  }
}
