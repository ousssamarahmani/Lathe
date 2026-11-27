import { describe, expect, it } from 'vitest';
import {
  SessionRequest,
  type KiroEvent,
  type KiroSession,
  type SandboxHandle,
} from '@lathe/shared-contracts';
import { AcpKiroAdapter, type AcpAdapterOptions } from './adapter.js';
import { KiroAdapterError, KiroTimeoutError } from './errors.js';
import type { SpawnContext } from './process.js';
import { FakeAcpServer, type FakeScript } from './testing/fake-acp-server.js';

const sandbox = {
  id: 'sb-test',
  spec: { secretEnv: ['KIRO_API_KEY'] },
  collectPatch: () => Promise.reject(new Error('not used')),
  destroy: () => Promise.resolve(),
} as unknown as SandboxHandle;

function request(over: Record<string, unknown> = {}): SessionRequest {
  return SessionRequest.parse({
    runId: '3f0c5c1e-6b2a-4c1e-8a4b-1d2e3f405162',
    agentProfile: 'builder',
    cwd: '/workspace/app',
    prompt: 'build it',
    timeoutMs: 60_000,
    mcpServers: [],
    ...over,
  });
}

async function open(
  script: FakeScript = {},
  options: AcpAdapterOptions = {},
  over: Record<string, unknown> = {},
): Promise<{ server: FakeAcpServer; session: KiroSession }> {
  const server = new FakeAcpServer(script);
  const adapter = new AcpKiroAdapter({ spawn: server.asSpawn(), ...options });
  const session = await adapter.start(request(over), sandbox);
  return { server, session };
}

async function collect(session: KiroSession): Promise<KiroEvent[]> {
  const out: KiroEvent[] = [];
  for await (const e of session.events()) out.push(e);
  return out;
}

const textChunk = (text: string) => ({
  do: 'update' as const,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
});

const editCall = (path: string, kind = 'edit') => ({
  do: 'permission' as const,
  toolCall: { toolCallId: 'tc', title: `${kind} ${path}`, kind, locations: [{ path }] },
});

describe('handshake', () => {
  it('runs initialize then session/new with no MCP servers', async () => {
    const { server, session } = await open();
    expect(server.received.map((m) => m['method'])).toEqual(['initialize', 'session/new']);
    const params = server.received[1]?.['params'] as Record<string, unknown>;
    expect(params['mcpServers']).toEqual([]);
    expect(params['cwd']).toBe('/workspace/app');
    expect(session.id).toBe('sess-fake-1');
    await session.close();
  });

  it('maps "Not logged in" to auth_required and kills the process', async () => {
    const server = new FakeAcpServer({ authRequired: true });
    const adapter = new AcpKiroAdapter({ spawn: server.asSpawn() });
    await expect(adapter.start(request(), sandbox)).rejects.toMatchObject({
      code: 'auth_required',
    });
    expect(server.killCount).toBeGreaterThan(0);
  });

  it.each(['initialize', 'session/new'] as const)(
    'times out when %s is never answered',
    async (hangOn) => {
      const server = new FakeAcpServer({ hangOn });
      const adapter = new AcpKiroAdapter({ spawn: server.asSpawn(), handshakeTimeoutMs: 50 });
      const err = await adapter.start(request(), sandbox).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(KiroTimeoutError);
      expect((err as KiroTimeoutError).phase).toBe('handshake');
      expect(server.killCount).toBeGreaterThan(0);
    },
  );

  it('rejects a request that violates C2 before spawning', async () => {
    let spawned = false;
    const adapter = new AcpKiroAdapter({
      spawn: () => {
        spawned = true;
        return new FakeAcpServer().process;
      },
    });
    const bad = { ...request(), mcpServers: [{ name: 'x' }] } as unknown as SessionRequest;
    await expect(adapter.start(bad, sandbox)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(spawned).toBe(false);
  });

  it('reports spawn_failed when the spawn function throws', async () => {
    const adapter = new AcpKiroAdapter({
      spawn: () => {
        throw new Error('ENOENT');
      },
    });
    await expect(adapter.start(request(), sandbox)).rejects.toMatchObject({
      code: 'spawn_failed',
    });
  });
});

describe('environment', () => {
  const capture = (options: AcpAdapterOptions): Promise<SpawnContext> => {
    let ctx: SpawnContext | undefined;
    const server = new FakeAcpServer();
    const adapter = new AcpKiroAdapter({
      ...options,
      spawn: (c) => {
        ctx = c;
        return server.process;
      },
    });
    return adapter.start(request(), sandbox).then(async (s) => {
      await s.close();
      if (!ctx) throw new Error('spawn not called');
      return ctx;
    });
  };

  it('passes no host variables by default', async () => {
    const ctx = await capture({ hostEnv: { KIRO_API_KEY: 'k', PATH: '/bin' } });
    expect(ctx.env).toEqual({});
    expect(ctx.command).toBe('kiro-cli');
    expect(ctx.args).toEqual(['acp']);
  });

  it('passes only allow-listed variables', async () => {
    const ctx = await capture({
      envAllowlist: ['KIRO_API_KEY'],
      hostEnv: { KIRO_API_KEY: 'k', GITHUB_TOKEN: 'x' },
    });
    expect(ctx.env).toEqual({ KIRO_API_KEY: 'k' });
  });
  it('throws at construction for any name outside the C2 secret set', () => {
    for (const name of ['GITHUB_TOKEN', 'LATHE_DB_OWNER_PASSWORD', 'HOME', 'kiro_api_key'])
      expect(() => new AcpKiroAdapter({ envAllowlist: [name] })).toThrow(KiroAdapterError);
  });
  it('withholds a secret the sandbox spec does not declare', async () => {
    const declared = { ...sandbox, spec: { secretEnv: [] } } as unknown as SandboxHandle;
    let ctx: SpawnContext | undefined;
    const server = new FakeAcpServer({});
    const spawn = server.asSpawn();
    const adapter = new AcpKiroAdapter({
      spawn: (c) => {
        ctx = c;
        return spawn(c);
      },
      envAllowlist: ['KIRO_API_KEY'],
      hostEnv: { KIRO_API_KEY: 'k' },
    });
    await (await adapter.start(request(), declared)).close();
    expect(ctx?.env).toEqual({});
  });
});

describe('prompt streaming', () => {
  it('maps session/update notifications to C2 events in seq order', async () => {
    const { session } = await open({
      promptSteps: [
        textChunk('hello'),
        {
          do: 'update',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-1',
            title: 'Write file',
            status: 'pending',
            rawInput: { path: 'a' },
          },
        },
        {
          do: 'update',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-1',
            status: 'completed',
            rawOutput: 'ok',
          },
        },
        { do: 'raw', line: JSON.stringify({ jsonrpc: '2.0', method: '_kiro/tools/didChange' }) },
        {
          do: 'update',
          update: { sessionUpdate: 'session_info_update', title: 't' },
        },
      ],
    });
    const result = await session.prompt('go');
    expect(result).toEqual({ stopReason: 'end_turn', eventCount: 4 });
    await session.close();
    const events = await collect(session);
    expect(events.map((e) => e.type)).toEqual([
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
      'turn_end',
    ]);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(events[0]).toMatchObject({ text: 'hello', sessionId: 'sess-fake-1' });
    expect(events[1]).toMatchObject({ toolCallId: 'tc-1', input: { path: 'a' } });
    const stats = (session as unknown as { stats(): { ignoredNotifications: object } }).stats();
    expect(stats.ignoredNotifications).toEqual({
      '_kiro/tools/didChange': 1,
      'session/update:session_info_update': 1,
    });
  });

  it('sends the prompt text as an ACP text block', async () => {
    const { server, session } = await open();
    await session.prompt('write tests');
    const sent = server.received.find((m) => m['method'] === 'session/prompt');
    expect(sent?.['params']).toEqual({
      sessionId: 'sess-fake-1',
      prompt: [{ type: 'text', text: 'write tests' }],
    });
    await session.close();
  });

  it('rejects a second prompt while one is running', async () => {
    const { session } = await open({ promptSteps: [{ do: 'hang' }] });
    const first = session.prompt('a');
    await expect(session.prompt('b')).rejects.toMatchObject({ code: 'busy' });
    await session.cancel('test');
    await first;
    await session.close();
  });

  it('rejects a prompt after close', async () => {
    const { session } = await open();
    await session.close();
    await expect(session.prompt('x')).rejects.toBeInstanceOf(KiroAdapterError);
  });
});

describe('cancel and timeouts', () => {
  it('cancel ends the turn with stopReason cancelled', async () => {
    const { server, session } = await open({ promptSteps: [{ do: 'hang' }] });
    const turn = session.prompt('long');
    await session.cancel('operator');
    expect(await turn).toMatchObject({ stopReason: 'cancelled' });
    expect(server.received.some((m) => m['method'] === 'session/cancel')).toBe(true);
    await session.cancel('again');
    await session.close();
  });

  it('prompt timeout cancels the turn and reports timeout', async () => {
    const { server, session } = await open(
      { promptSteps: [{ do: 'hang' }] },
      { promptTimeoutMs: 50 },
    );
    expect(await session.prompt('slow')).toMatchObject({ stopReason: 'timeout' });
    expect(server.received.some((m) => m['method'] === 'session/cancel')).toBe(true);
    await session.close();
    const events = await collect(session);
    expect(events.some((e) => e.type === 'adapter_error' && e.code === 'timeout')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', stopReason: 'timeout' });
  });

  it('kills the process when a timed-out turn ignores the cancel', async () => {
    const { server, session } = await open(
      { promptSteps: [{ do: 'hang' }], ignoreCancel: true },
      { promptTimeoutMs: 50, cancelTimeoutMs: 50 },
    );
    expect(await session.prompt('stuck')).toMatchObject({ stopReason: 'timeout' });
    expect(server.killCount).toBeGreaterThan(0);
    await session.close();
  });

  it('cancel() throws a typed timeout and kills the process when the turn never ends', async () => {
    const { server, session } = await open(
      { promptSteps: [{ do: 'hang' }], ignoreCancel: true },
      { cancelTimeoutMs: 50 },
    );
    const turn = session.prompt('stuck');
    const err = await session.cancel('operator').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KiroTimeoutError);
    expect((err as KiroTimeoutError).phase).toBe('cancel');
    expect(await turn).toMatchObject({ stopReason: 'timeout' });
    expect(server.killCount).toBeGreaterThan(0);
    await session.close();
  });

  it('the session limit ends a running turn with timeout', async () => {
    const { session } = await open({ promptSteps: [{ do: 'hang' }] }, {}, { timeoutMs: 1_000 });
    expect(await session.prompt('long')).toMatchObject({ stopReason: 'timeout' });
    await expect(session.prompt('again')).rejects.toBeInstanceOf(KiroTimeoutError);
    await session.close();
  });
});

describe('permission requests', () => {
  const reply = (server: FakeAcpServer, i: number): unknown =>
    (server.permissionReplies[i] as { outcome: unknown }).outcome;

  it('rejects every request when there is no policy', async () => {
    const { server, session } = await open({
      promptSteps: [
        editCall('/workspace/app/a.ts'),
        { do: 'permission', toolCall: { toolCallId: 't2', kind: 'read' } },
      ],
    });
    await session.prompt('go');
    expect(reply(server, 0)).toEqual({ outcome: 'selected', optionId: 'reject_once' });
    expect(reply(server, 1)).toEqual({ outcome: 'selected', optionId: 'reject_once' });
    await session.close();
    const events = (await collect(session)).filter((e) => e.type === 'permission_request');
    expect(events.map((e) => e.type === 'permission_request' && e.decision)).toEqual([
      'rejected',
      'rejected',
    ]);
  });

  it('allows what the policy allows and rejects the rest', async () => {
    const { server, session } = await open(
      {
        promptSteps: [
          editCall('/workspace/app/src/a.ts'),
          editCall('/workspace/other/a.ts'),
          editCall('/workspace/app/../etc/passwd'),
          editCall('/workspace/app-evil/a.ts'),
          { do: 'permission', toolCall: { toolCallId: 'c', kind: 'execute', title: 'ls' } },
          { do: 'permission', toolCall: { toolCallId: 'f', kind: 'fetch', title: 'curl' } },
          { do: 'permission', toolCall: { toolCallId: 'e', kind: 'edit', title: 'no path' } },
        ],
      },
      {},
      { permissionPolicy: { allowWritesUnder: ['/workspace/app'], allowCommands: false } },
    );
    await session.prompt('go');
    const outcomes = server.permissionReplies.map(
      (r) => (r as { outcome: { optionId: string } }).outcome.optionId,
    );
    expect(outcomes).toEqual([
      'allow_once',
      'reject_once',
      'reject_once',
      'reject_once',
      'reject_once',
      'reject_once',
      'reject_once',
    ]);
    await session.close();
  });

  it('allows commands only when the policy says so', async () => {
    const { server, session } = await open(
      { promptSteps: [{ do: 'permission', toolCall: { toolCallId: 'c', kind: 'execute' } }] },
      {},
      { permissionPolicy: { allowWritesUnder: ['/workspace/app'], allowCommands: true } },
    );
    await session.prompt('go');
    expect(reply(server, 0)).toEqual({ outcome: 'selected', optionId: 'allow_once' });
    await session.close();
  });

  it('never picks allow_always and rejects when no allow_once is offered', async () => {
    const { server, session } = await open(
      {
        promptSteps: [
          {
            do: 'permission',
            toolCall: {
              toolCallId: 'r',
              kind: 'read',
              locations: [{ path: '/workspace/app/a.ts' }],
            },
            options: [{ optionId: 'always', kind: 'allow_always' }],
          },
        ],
      },
      {},
      { permissionPolicy: { allowWritesUnder: ['/workspace/app'], allowCommands: false } },
    );
    await session.prompt('go');
    expect(reply(server, 0)).toEqual({ outcome: 'cancelled' });
    await session.close();
  });
});

describe('malformed input', () => {
  it('turns bad lines into error events and keeps going', async () => {
    const { session } = await open({
      promptSteps: [
        { do: 'raw', line: 'this is not json' },
        { do: 'raw', line: JSON.stringify({ jsonrpc: '1.0', method: 'x' }) },
        { do: 'raw', line: JSON.stringify({ jsonrpc: '2.0', id: 4242, result: {} }) },
        {
          do: 'update',
          update: { sessionUpdate: 'tool_call', title: 'no id' },
        },
        {
          do: 'raw',
          line: JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: 'someone-else', update: { sessionUpdate: 'agent_message_chunk' } },
          }),
        },
        textChunk('still alive'),
      ],
    });
    expect(await session.prompt('go')).toMatchObject({ stopReason: 'end_turn' });
    await session.close();
    const events = await collect(session);
    const errors = events.filter((e) => e.type === 'adapter_error');
    expect(errors).toHaveLength(5);
    expect(errors.every((e) => e.type === 'adapter_error' && e.code === 'protocol_error')).toBe(
      true,
    );
    expect(events.some((e) => e.type === 'agent_message_chunk')).toBe(true);
  });

  it('answers an unsupported agent request with a JSON-RPC error', async () => {
    const { server, session } = await open({
      promptSteps: [
        {
          do: 'raw',
          line: JSON.stringify({
            jsonrpc: '2.0',
            id: 5,
            method: 'fs/read_text_file',
            params: { path: '/etc/passwd' },
          }),
        },
        { do: 'wait', ms: 20 },
      ],
    });
    await session.prompt('go');
    const answer = server.received.find((m) => m['id'] === 5);
    expect(answer?.['error']).toMatchObject({ code: -32601 });
    await session.close();
  });
});

describe('process failures', () => {
  it('reports process_exited and ends the turn with error when the child dies mid-prompt', async () => {
    const { session } = await open({
      promptSteps: [textChunk('partial'), { do: 'exit', code: 3 }],
    });
    expect(await session.prompt('go')).toMatchObject({ stopReason: 'error' });
    const events = await collect(session);
    expect(events.map((e) => e.type)).toEqual(['agent_message_chunk', 'adapter_error', 'turn_end']);
    expect(events[1]).toMatchObject({ code: 'process_exited' });
    await session.close();
  });

  it('close() is idempotent, kills the child and ends the event stream', async () => {
    const { server, session } = await open();
    await session.close();
    await session.close();
    expect(server.killCount).toBeGreaterThan(0);
    expect(await collect(session)).toEqual([]);
  });
});

describe('event size and count limits', () => {
  it('replaces an oversized rawInput and rawOutput with a marker', async () => {
    const big = 'x'.repeat(100_000);
    const { session } = await open({
      promptSteps: [
        {
          do: 'update',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 't',
            status: 'pending',
            rawInput: { big },
          },
        },
        {
          do: 'update',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 't',
            status: 'completed',
            rawOutput: { big },
          },
        },
      ],
    });
    await session.prompt('go');
    await session.close();
    const events = await collect(session);
    const call = events.find((e) => e.type === 'tool_call');
    const update = events.find((e) => e.type === 'tool_call_update');
    expect(JSON.stringify(call).length).toBeLessThan(2_000);
    expect(JSON.stringify(update).length).toBeLessThan(2_000);
    expect(call).toMatchObject({ input: { truncated: true } });
    expect(update).toMatchObject({ output: { truncated: true } });
  });
  it('caps the events kept per session but still ends the turn', async () => {
    const steps = Array.from({ length: 10_200 }, () => textChunk('x'));
    const { session } = await open({ promptSteps: steps });
    const result = await session.prompt('go');
    expect(result.stopReason).toBe('end_turn');
    await session.close();
    const events = await collect(session);
    expect(events.length).toBeLessThanOrEqual(10_002);
    expect(events.at(-1)).toMatchObject({ type: 'turn_end' });
    expect(events.some((e) => e.type === 'adapter_error')).toBe(true);
  });
});
