/**
 * C2 `KiroAdapter` over ACP: JSON-RPC 2.0, one JSON object per line, on the stdio of
 * `kiro-cli acp` (mode B, ADR 0003, spike P0-04). The process is started through an
 * injected `SpawnFn`, so tests never run the real CLI.
 */
import { StringDecoder } from 'node:string_decoder';
import {
  KiroEvent,
  SessionId,
  SecretEnvName,
  SessionRequest,
  StopReason,
  type KiroAdapter,
  type KiroSession,
  type SandboxHandle,
  type TurnResult,
} from '@lathe/shared-contracts';
import {
  AgentMessageChunk,
  InboundMessage,
  InitializeResult,
  NewSessionResult,
  PermissionParams,
  PromptResult,
  SessionUpdateParams,
  ToolCallProgressMsg,
  ToolCallUpdateMsg,
  type RpcId,
} from './acp-schemas.js';
import { KiroAdapterError, KiroTimeoutError, type TimeoutPhase } from './errors.js';
import { decidePermission, type PermissionPolicy } from './permission-policy.js';
import { hostSpawn, type AcpProcess, type ExitInfo, type SpawnFn } from './process.js';

export interface AcpAdapterOptions {
  /** Starts the ACP process. Defaults to `hostSpawn` (smoke script only). */
  spawn?: SpawnFn;
  command?: string;
  args?: readonly string[];
  /** Names of host variables the child may inherit. Empty by default. */
  envAllowlist?: readonly string[];
  /** Source of host variables for the allow-list. Defaults to `process.env`. */
  hostEnv?: Readonly<Record<string, string | undefined>>;
  /** `initialize` and `session/new` each get this long. The spike measured about 7 s. */
  handshakeTimeoutMs?: number;
  /** One `session/prompt` turn. On expiry the adapter cancels and ends the turn with `timeout`. */
  promptTimeoutMs?: number;
  /** How long a cancelled turn may take to end before the process is killed. */
  cancelTimeoutMs?: number;
  /** How long `close()` waits for the process to exit. */
  closeTimeoutMs?: number;
  now?: () => Date;
}

const DEFAULTS = {
  command: 'kiro-cli',
  args: ['acp'] as readonly string[],
  handshakeTimeoutMs: 30_000,
  promptTimeoutMs: 600_000,
  cancelTimeoutMs: 10_000,
  closeTimeoutMs: 5_000,
};

/** Largest JSON size of one tool `rawInput` or `rawOutput` kept in an event. */
const MAX_PAYLOAD_CHARS = 16_384;
/** Events kept per session. Past this only `turn_end` is recorded, after one error event. */
const MAX_EVENTS = 10_000;

/** Replaces an oversized or unserializable payload with a small marker. */
function capPayload(value: unknown): unknown {
  let size: number;
  try {
    size = JSON.stringify(value)?.length ?? 0;
  } catch {
    return { truncated: true, reason: 'not serializable' };
  }
  return size > MAX_PAYLOAD_CHARS ? { truncated: true, originalChars: size } : value;
}

/** Longest line accepted from the child. A longer one is dropped as a protocol error. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventBody = DistributiveOmit<KiroEvent, 'sessionId' | 'seq' | 'at'>;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

interface Turn {
  settled: Promise<void>;
  markSettled: () => void;
  startedAtEvent: number;
  timedOut: boolean;
  cancelTimer: NodeJS.Timeout | undefined;
}

export interface SessionStats {
  /** Notifications the adapter accepted but does not map to a C2 event, by method. */
  ignoredNotifications: Readonly<Record<string, number>>;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

class AcpSession implements KiroSession {
  id: SessionId = SessionId.parse('pending');
  private readonly log: KiroEvent[] = [];
  private waiters: Array<() => void> = [];
  private finished = false;
  private seq = 0;
  private readonly pending = new Map<RpcId, Pending>();
  private nextId = 1;
  private turn: Turn | undefined;
  private closing = false;
  private expired = false;
  private exited = false;
  private readonly exitedPromise: Promise<void>;
  private sessionTimer: NodeJS.Timeout | undefined;
  private readonly ignored: Record<string, number> = {};
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private discarding = false;
  private overflowed = false;

  constructor(
    private readonly proc: AcpProcess,
    private readonly request: SessionRequest,
    private readonly cfg: typeof DEFAULTS & { now: () => Date },
    private readonly readRoots: readonly string[],
  ) {
    this.exitedPromise = new Promise<void>((resolve) => {
      proc.onExit((info) => {
        this.onProcessExit(info);
        resolve();
      });
    });
    proc.stdout.on('data', (chunk: Buffer | string) => {
      this.onData(typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
    });
    proc.stdout.on('error', () => undefined);
    proc.stdin.on('error', () => undefined);
    // stderr may carry secrets. It is drained and never stored.
    proc.stderr?.on('error', () => undefined);
    proc.stderr?.resume();
  }

  stats(): SessionStats {
    return { ignoredNotifications: { ...this.ignored } };
  }

  // ---- lifecycle -------------------------------------------------------------

  async handshake(): Promise<void> {
    const t = this.cfg.handshakeTimeoutMs;
    const init = await this.call(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'lathe', version: '0.1.0' },
      },
      'handshake',
      t,
    );
    InitializeResult.parse(init);
    const created = NewSessionResult.parse(
      await this.call('session/new', { cwd: this.request.cwd, mcpServers: [] }, 'handshake', t),
    );
    this.id = SessionId.parse(created.sessionId);
    this.sessionTimer = setTimeout(() => {
      this.onSessionTimeout();
    }, this.request.timeoutMs);
    this.sessionTimer.unref();
  }

  async prompt(text: string): Promise<TurnResult> {
    if (this.closing || this.exited) throw new KiroAdapterError('closed', 'session is closed');
    if (this.expired) throw new KiroTimeoutError('session', this.request.timeoutMs, 'expired');
    if (this.turn) throw new KiroAdapterError('busy', 'a prompt is already running');
    if (text.length === 0 || text.length > 200_000)
      throw new KiroAdapterError('invalid_request', 'prompt must be 1 to 200000 characters');

    let markSettled!: () => void;
    const settled = new Promise<void>((r) => {
      markSettled = r;
    });
    const turn: Turn = {
      settled,
      markSettled,
      startedAtEvent: this.log.length,
      timedOut: false,
      cancelTimer: undefined,
    };
    this.turn = turn;
    const promptTimer = setTimeout(() => {
      this.timeoutTurn(turn, 'prompt');
    }, this.cfg.promptTimeoutMs);

    let stop: StopReason = 'error';
    try {
      const raw = await this.call(
        'session/prompt',
        { sessionId: this.id, prompt: [{ type: 'text', text }] },
        undefined,
        undefined,
      );
      const parsed = StopReason.safeParse(PromptResult.parse(raw).stopReason);
      if (parsed.success) stop = parsed.data;
      else this.protocolError('unknown stop reason from agent');
    } catch (e) {
      // Exit and close already produced their own event. Anything else is a protocol problem.
      if (!(e instanceof KiroAdapterError && (e.code === 'process_exited' || e.code === 'closed')))
        this.protocolError(`prompt failed: ${errorMessage(e)}`);
    } finally {
      clearTimeout(promptTimer);
      if (turn.cancelTimer) clearTimeout(turn.cancelTimer);
    }
    if (turn.timedOut) stop = 'timeout';
    else if (this.closing && stop === 'error') stop = 'cancelled';
    this.emit({ type: 'turn_end', stopReason: stop });
    const eventCount = this.log.length - turn.startedAtEvent;
    this.turn = undefined;
    turn.markSettled();
    return { stopReason: stop, eventCount };
  }

  async cancel(reason: string): Promise<void> {
    const turn = this.turn;
    if (!turn || this.closing || this.exited) return;
    this.sendCancel();
    const timeoutMs = this.cfg.cancelTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => {
        resolve('expired');
      }, timeoutMs);
    });
    const outcome = await Promise.race([turn.settled.then(() => 'settled' as const), expired]);
    if (timer) clearTimeout(timer);
    if (outcome === 'expired') {
      turn.timedOut = true;
      const message = `cancel did not end the turn (${reason.slice(0, 200)})`;
      this.emit({ type: 'adapter_error', code: 'timeout', message });
      this.proc.kill();
      await turn.settled;
      throw new KiroTimeoutError('cancel', timeoutMs, reason.slice(0, 200));
    }
  }

  async close(): Promise<void> {
    if (this.closing) {
      await this.exitedPromise;
      return;
    }
    this.closing = true;
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.rejectAll(new KiroAdapterError('closed', 'session closed'));
    try {
      this.proc.stdin.end();
    } catch {
      // stdin already closed; kill below ends the process.
    }
    this.proc.kill();
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.cfg.closeTimeoutMs);
    });
    await Promise.race([this.exitedPromise, limit]);
    if (timer) clearTimeout(timer);
    this.finish();
  }

  events(): AsyncIterable<KiroEvent> {
    return { [Symbol.asyncIterator]: () => this.iterate() };
  }

  /** Each call replays the log from seq 0, then follows new events until the session ends. */
  private async *iterate(): AsyncGenerator<KiroEvent> {
    let i = 0;
    for (;;) {
      for (let e = this.log[i]; e !== undefined; e = this.log[i]) {
        i += 1;
        yield e;
      }
      if (this.finished) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  // ---- timeouts --------------------------------------------------------------

  private timeoutTurn(turn: Turn, phase: TimeoutPhase): void {
    if (turn.timedOut) return;
    turn.timedOut = true;
    this.emit({ type: 'adapter_error', code: 'timeout', message: `${phase} timed out` });
    this.sendCancel();
    turn.cancelTimer = setTimeout(() => {
      this.proc.kill();
    }, this.cfg.cancelTimeoutMs);
  }

  private onSessionTimeout(): void {
    this.expired = true;
    if (this.turn) {
      this.timeoutTurn(this.turn, 'session');
    } else {
      this.emit({ type: 'adapter_error', code: 'timeout', message: 'session timed out' });
      void this.close();
    }
  }

  // ---- outbound --------------------------------------------------------------

  private write(message: unknown): void {
    if (this.exited) return;
    try {
      this.proc.stdin.write(JSON.stringify(message) + '\n');
    } catch (e) {
      this.protocolError(`write failed: ${errorMessage(e)}`);
    }
  }

  private sendCancel(): void {
    this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.id } });
  }

  /** Sends a request. A timeout of `undefined` means the caller manages timing. */
  private call(
    method: string,
    params: unknown,
    phase: TimeoutPhase | undefined,
    timeoutMs: number | undefined,
  ): Promise<unknown> {
    if (this.exited)
      return Promise.reject(new KiroAdapterError('process_exited', 'process already exited'));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const entry: Pending = { resolve, reject, timer: undefined };
      if (phase !== undefined && timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new KiroTimeoutError(phase, timeoutMs, method));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private rejectAll(error: Error): void {
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(error);
    }
  }

  // ---- inbound ---------------------------------------------------------------

  private onData(text: string): void {
    this.buffer += text;
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (this.discarding) {
        this.discarding = false;
        continue;
      }
      this.handleLine(line);
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = '';
      this.discarding = true;
      this.protocolError('inbound line too long, dropped');
    }
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      this.protocolError('malformed JSON from agent');
      return;
    }
    const parsed = InboundMessage.safeParse(json);
    if (!parsed.success) {
      this.protocolError('invalid JSON-RPC message from agent');
      return;
    }
    const msg = parsed.data;
    if (msg.method !== undefined) {
      if (msg.id !== undefined) this.handleAgentRequest(msg.id, msg.method, msg.params);
      else this.handleNotification(msg.method, msg.params);
      return;
    }
    if (msg.id === undefined) return;
    const entry = this.pending.get(msg.id);
    if (!entry) {
      this.protocolError('response with unknown id');
      return;
    }
    this.pending.delete(msg.id);
    if (entry.timer) clearTimeout(entry.timer);
    if (msg.error) {
      const authFailure = msg.error.code === -32000 && /auth/i.test(msg.error.message);
      entry.reject(
        new KiroAdapterError(
          authFailure ? 'auth_required' : 'protocol_error',
          `agent error ${msg.error.code}: ${msg.error.message.slice(0, 500)}`,
        ),
      );
    } else {
      entry.resolve(msg.result);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update') {
      this.ignore(method);
      return;
    }
    const p = SessionUpdateParams.safeParse(params);
    if (!p.success) {
      this.protocolError('invalid session/update');
      return;
    }
    if (p.data.sessionId !== this.id) {
      this.protocolError('session/update for another session');
      return;
    }
    const update = p.data.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const c = AgentMessageChunk.safeParse(update);
        if (!c.success) return this.protocolError('invalid agent_message_chunk');
        if (c.data.content.type === 'text' && c.data.content.text)
          this.emit({ type: 'agent_message_chunk', text: c.data.content.text.slice(0, 100_000) });
        else this.ignore('agent_message_chunk:non-text');
        return;
      }
      case 'tool_call': {
        const c = ToolCallUpdateMsg.safeParse(update);
        if (!c.success) return this.protocolError('invalid tool_call');
        this.emit({
          type: 'tool_call',
          toolCallId: c.data.toolCallId,
          title: (c.data.title ?? '').slice(0, 500),
          status: c.data.status ?? 'pending',
          input: capPayload(c.data.rawInput ?? null),
        });
        return;
      }
      case 'tool_call_update': {
        const c = ToolCallProgressMsg.safeParse(update);
        if (!c.success) return this.protocolError('invalid tool_call_update');
        this.emit({
          type: 'tool_call_update',
          toolCallId: c.data.toolCallId,
          status: c.data.status ?? 'in_progress',
          ...(c.data.rawOutput !== undefined ? { output: capPayload(c.data.rawOutput) } : {}),
        });
        return;
      }
      default:
        this.ignore(`session/update:${update.sessionUpdate}`);
    }
  }

  private handleAgentRequest(id: RpcId, method: string, params: unknown): void {
    if (method !== 'session/request_permission') {
      // No client capabilities were advertised, so the agent has no business asking.
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'method not supported' },
      });
      this.ignore(`request:${method}`);
      return;
    }
    const p = PermissionParams.safeParse(params);
    if (!p.success || p.data.sessionId !== this.id) {
      this.protocolError('invalid or foreign session/request_permission');
      this.write({
        jsonrpc: '2.0',
        id,
        result: { outcome: { outcome: 'cancelled' } },
      });
      return;
    }
    const { toolCall, options } = p.data;
    const policy: PermissionPolicy | undefined = this.request.permissionPolicy;
    let decision = decidePermission(policy, toolCall, this.readRoots);
    const allowOption = options.find((o) => o.kind === 'allow_once');
    if (decision.allowed && !allowOption)
      decision = { allowed: false, reason: 'no allow_once option offered' };
    const rejectOption =
      options.find((o) => o.kind === 'reject_once') ??
      options.find((o) => o.kind === 'reject_always');
    const chosen = decision.allowed ? allowOption : rejectOption;
    this.emit({
      type: 'permission_request',
      toolCallId: toolCall.toolCallId,
      title: (toolCall.title ?? '').slice(0, 500),
      decision: decision.allowed ? 'allowed' : 'rejected',
      reason: decision.reason.slice(0, 500),
    });
    this.write({
      jsonrpc: '2.0',
      id,
      result: {
        outcome: chosen
          ? { outcome: 'selected', optionId: chosen.optionId }
          : { outcome: 'cancelled' },
      },
    });
  }

  private ignore(key: string): void {
    this.ignored[key] = (this.ignored[key] ?? 0) + 1;
  }

  // ---- events ----------------------------------------------------------------

  private protocolError(message: string): void {
    this.emit({ type: 'adapter_error', code: 'protocol_error', message: message.slice(0, 2000) });
  }

  private emit(input: EventBody): void {
    if (this.finished) return;
    let body = input;
    if (this.seq >= MAX_EVENTS && body.type !== 'turn_end') {
      this.ignore('event_limit');
      if (this.overflowed) return;
      this.overflowed = true;
      body = {
        type: 'adapter_error',
        code: 'protocol_error',
        message: `event limit of ${String(MAX_EVENTS)} reached, later events dropped`,
      };
    }
    const candidate = {
      ...body,
      sessionId: this.id,
      seq: this.seq,
      at: this.cfg.now().toISOString(),
    };
    const parsed = KiroEvent.safeParse(candidate);
    if (!parsed.success) {
      // Never drop silently and never recurse: replace with a minimal valid error event.
      const fallback = KiroEvent.parse({
        type: 'adapter_error',
        code: 'protocol_error',
        message: `event rejected by contract: ${body.type}`,
        sessionId: this.id,
        seq: this.seq,
        at: candidate.at,
      });
      this.seq += 1;
      this.log.push(fallback);
    } else {
      this.seq += 1;
      this.log.push(parsed.data);
    }
    this.wake();
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private finish(): void {
    this.finished = true;
    this.wake();
  }

  private onProcessExit(info: ExitInfo): void {
    this.exited = true;
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    const unexpected = !this.closing && !(this.turn?.timedOut ?? false);
    if (unexpected) {
      const detail = info.error
        ? `process error: ${info.error.slice(0, 500)}`
        : `process exited (code ${String(info.code)}, signal ${String(info.signal)})`;
      this.emit({
        type: 'adapter_error',
        code: info.error ? 'spawn_failed' : 'process_exited',
        message: detail,
      });
    }
    this.rejectAll(new KiroAdapterError('process_exited', 'agent process exited'));
    // Let a running prompt() write its turn_end before the stream ends.
    const finishWhenIdle = (): void => {
      if (this.turn) void this.turn.settled.then(() => this.finish());
      else this.finish();
    };
    setImmediate(finishWhenIdle);
  }
}

/** Container paths of the mounts an agent may read: the target app and the foundation. */
function readRootsOf(sandbox: SandboxHandle): string[] {
  const mounts = sandbox.spec.mounts ?? [];
  return mounts
    .filter((m) => m.source === 'target-app' || m.source === 'application-foundation')
    .map((m) => m.containerPath);
}

export class AcpKiroAdapter implements KiroAdapter {
  private readonly spawn: SpawnFn;
  private readonly cfg: typeof DEFAULTS & { now: () => Date };
  private readonly envAllowlist: readonly string[];
  private readonly hostEnv: Readonly<Record<string, string | undefined>>;

  constructor(options: AcpAdapterOptions = {}) {
    this.spawn = options.spawn ?? hostSpawn;
    for (const name of options.envAllowlist ?? []) {
      if (!SecretEnvName.safeParse(name).success)
        throw new KiroAdapterError(
          'invalid_request',
          `envAllowlist may only name C2 secrets, not ${name.slice(0, 50)}`,
        );
    }
    this.envAllowlist = options.envAllowlist ?? [];
    this.hostEnv = options.hostEnv ?? process.env;
    this.cfg = {
      command: options.command ?? DEFAULTS.command,
      args: options.args ?? DEFAULTS.args,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULTS.handshakeTimeoutMs,
      promptTimeoutMs: options.promptTimeoutMs ?? DEFAULTS.promptTimeoutMs,
      cancelTimeoutMs: options.cancelTimeoutMs ?? DEFAULTS.cancelTimeoutMs,
      closeTimeoutMs: options.closeTimeoutMs ?? DEFAULTS.closeTimeoutMs,
      now: options.now ?? (() => new Date()),
    };
  }

  async start(rawRequest: SessionRequest, sandbox: SandboxHandle): Promise<KiroSession> {
    const parsed = SessionRequest.safeParse(rawRequest);
    if (!parsed.success)
      throw new KiroAdapterError('invalid_request', 'session request violates contract C2', {
        cause: parsed.error,
      });
    const request = parsed.data;

    const env: Record<string, string> = {};
    // A secret enters the child only when the sandbox spec declares it (C2 secretEnv).
    const declared = new Set<string>(sandbox.spec.secretEnv ?? []);
    for (const name of this.envAllowlist) {
      if (!declared.has(name)) continue;
      const value = this.hostEnv[name];
      if (value !== undefined) env[name] = value;
    }

    let proc: AcpProcess;
    try {
      proc = this.spawn({
        command: this.cfg.command,
        args: this.cfg.args,
        env,
        sandbox,
        request,
      });
    } catch (e) {
      throw new KiroAdapterError('spawn_failed', `could not start ${this.cfg.command}`, {
        cause: e,
      });
    }

    const session = new AcpSession(proc, request, this.cfg, readRootsOf(sandbox));
    try {
      await session.handshake();
    } catch (e) {
      await session.close();
      if (e instanceof KiroAdapterError) throw e;
      throw new KiroAdapterError('protocol_error', `handshake failed: ${errorMessage(e)}`, {
        cause: e,
      });
    }
    return session;
  }
}
