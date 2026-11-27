import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SessionRequest, type SandboxHandle } from '@lathe/shared-contracts';
import { AcpKiroAdapter } from './adapter.js';
import { ReplayAcpServer, parseTranscript } from './testing/fake-acp-server.js';

const sandbox = { id: 'sb', spec: { secretEnv: [], mounts: [] } } as unknown as SandboxHandle;

function transcript(name: string): ReplayAcpServer {
  const url = new URL(`../fixtures/transcripts/${name}`, import.meta.url);
  return new ReplayAcpServer(parseTranscript(readFileSync(fileURLToPath(url), 'utf8')));
}

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

describe('transcript replay', () => {
  it('edit-turn: handshake, streaming, extension notification and an allowed edit', async () => {
    const server = transcript('edit-turn.jsonl');
    const adapter = new AcpKiroAdapter({ spawn: server.asSpawn() });
    const session = await adapter.start(
      request({
        permissionPolicy: { allowWritesUnder: ['/workspace/app'], allowCommands: false },
      }),
      sandbox,
    );
    expect(session.id).toBe('sess-replay-1');
    const result = await session.prompt('create the file');
    expect(result.stopReason).toBe('end_turn');
    await session.close();

    const events = [];
    for await (const e of session.events()) events.push(e);
    expect(events.map((e) => e.type)).toEqual([
      'agent_message_chunk',
      'tool_call',
      'permission_request',
      'tool_call_update',
      'agent_message_chunk',
      'turn_end',
    ]);
    expect(events[2]).toMatchObject({ decision: 'allowed', toolCallId: 'tc-1' });
    expect(server.mismatches).toEqual([]);
    expect(server.finished).toBe(true);
  });

  it('cancelled-turn: session/cancel is sent and the turn ends cancelled', async () => {
    const server = transcript('cancelled-turn.jsonl');
    const adapter = new AcpKiroAdapter({ spawn: server.asSpawn() });
    const session = await adapter.start(request(), sandbox);
    const turn = session.prompt('long task');
    for await (const e of session.events()) if (e.type === 'agent_message_chunk') break;
    await session.cancel('test');
    expect(await turn).toMatchObject({ stopReason: 'cancelled' });
    expect(server.mismatches).toEqual([]);
    expect(server.finished).toBe(true);
    await session.close();
  });
});
