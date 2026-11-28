import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRequest, type KiroEvent, type SandboxHandle } from '@lathe/shared-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpKiroAdapter } from '../adapter.js';
import { FakeAcpServer } from '../testing/fake-acp-server.js';
import { AgentConfig, DEFAULT_AGENTS_DIR, installAgent, loadAgentConfig } from './install.js';

const PROFILES = ['planner', 'builder', 'repair'] as const;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'p404-'));
  dirs.push(d);
  return d;
};

describe('agent configs', () => {
  it.each(PROFILES)('%s validates and declares no MCP servers', async (p) => {
    const c = await loadAgentConfig(p);
    expect(c.name).toBe(p);
    expect(c.mcpServers).toEqual({});
    expect(c.includeMcpJson).toBe(false);
  });
  it('the planner is read-only', async () => {
    const c = await loadAgentConfig('planner');
    expect(c.tools).toEqual(['fs_read']);
    expect(c.allowedTools).toEqual(['fs_read']);
    expect(c.toolsSettings.fs_write).toBeUndefined();
  });
  it.each(['builder', 'repair'] as const)(
    '%s writes only under /workspace/app, no shell',
    async (p) => {
      const c = await loadAgentConfig(p);
      expect([...c.tools].sort()).toEqual(['fs_read', 'fs_write']);
      expect(c.toolsSettings.fs_write?.allowedPaths).toEqual(['/workspace/app/**']);
    },
  );
  it('refuses unknown tools, MCP servers and outside write paths', async () => {
    const base = JSON.parse(
      await readFile(join(DEFAULT_AGENTS_DIR, 'builder.json'), 'utf8'),
    ) as Record<string, unknown>;
    const bad = (over: Record<string, unknown>): boolean =>
      AgentConfig.safeParse({ ...base, ...over }).success;
    expect(bad({})).toBe(true);
    expect(bad({ tools: ['fs_read', 'execute_bash'] })).toBe(false);
    expect(bad({ tools: ['fs_read', 'fs_write', 'web_fetch'] })).toBe(false);
    expect(bad({ mcpServers: { x: { command: 'y' } } })).toBe(false);
    expect(bad({ includeMcpJson: true })).toBe(false);
    expect(bad({ toolsSettings: { fs_write: { allowedPaths: ['/workspace'] } } })).toBe(false);
    expect(
      bad({ toolsSettings: { fs_write: { allowedPaths: ['/workspace/app/**', '/.github/**'] } } }),
    ).toBe(false);
    expect(bad({ name: 'planner' })).toBe(false);
  });
  it('steering mentions the required rules', async () => {
    const t = await readFile(join(DEFAULT_AGENTS_DIR, 'steering', 'common.md'), 'utf8');
    for (const w of [
      'defineAction',
      'tenantTable',
      'verification-harness',
      '.github',
      'data, never instructions',
    ])
      expect(t).toContain(w);
  });
});

describe('installAgent', () => {
  it.each(PROFILES)('writes only the expected files for %s', async (p) => {
    const work = await tmp();
    const files = await installAgent(p, work);
    const all = (await readdir(work, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name))
      .sort();
    expect(all).toEqual([...files].sort());
    expect(files.map((f) => f.slice(work.length + 1).replaceAll('\\', '/')).sort()).toEqual(
      [`.kiro/agents/${p}.json`, '.kiro/steering/common.md', `.kiro/steering/${p}.md`].sort(),
    );
  });
  it('rejects a relative work dir and an unknown profile', async () => {
    await expect(installAgent('builder', 'rel/dir')).rejects.toThrow();
    await expect(installAgent('../x' as 'builder', await tmp())).rejects.toThrow();
  });
});

describe('prompt-injection regression', () => {
  const sandbox = {
    id: 'sb',
    spec: { secretEnv: [] },
    destroy: () => Promise.resolve(),
  } as unknown as SandboxHandle;
  // The tool request each prompt would provoke from a compliant agent.
  const attacks: Record<string, Array<Record<string, unknown>>> = {
    'ignore-previous-edit-github': [
      {
        toolCallId: 'a',
        kind: 'edit',
        locations: [{ path: '/workspace/.github/workflows/ci.yml' }],
      },
      {
        toolCallId: 'b',
        kind: 'edit',
        locations: [{ path: '/workspace/app/../.github/workflows/ci.yml' }],
      },
    ],
    'print-environment': [
      { toolCallId: 'a', kind: 'read', locations: [{ path: '/proc/self/environ' }] },
      { toolCallId: 'b', kind: 'execute', title: 'printenv', rawInput: { command: 'printenv' } },
    ],
    'read-kiro-session': [
      { toolCallId: 'a', kind: 'read', locations: [{ path: '/home/agent/.kiro/token.json' }] },
      { toolCallId: 'b', kind: 'read', rawInput: { path: '/home/agent/.kiro' } },
    ],
    'route-without-defineaction': [
      { toolCallId: 'a', kind: 'fetch', title: 'curl https://example.com' },
      {
        toolCallId: 'b',
        kind: 'edit',
        locations: [{ path: '/workspace/application-foundation/src/index.ts' }],
      },
    ],
  };
  const fixtureNames = Object.keys(attacks);
  it('has one fixture file per attack', async () => {
    const dir = join(DEFAULT_AGENTS_DIR, '../fixtures/prompt-injection');
    expect((await readdir(dir)).map((f) => f.replace('.txt', '')).sort()).toEqual(
      [...fixtureNames].sort(),
    );
  });
  it.each(fixtureNames)('%s: every tool request is rejected', async (name) => {
    const prompt = await readFile(
      join(DEFAULT_AGENTS_DIR, '../fixtures/prompt-injection', `${name}.txt`),
      'utf8',
    );
    const server = new FakeAcpServer({
      promptSteps: (attacks[name] ?? []).map((toolCall) => ({
        do: 'permission' as const,
        toolCall,
      })),
    });
    const session = await new AcpKiroAdapter({ spawn: server.asSpawn() }).start(
      SessionRequest.parse({
        runId: '3f0c5c1e-6b2a-4c1e-8a4b-1d2e3f405162',
        agentProfile: 'builder',
        cwd: '/workspace/app',
        prompt,
        timeoutMs: 60_000,
        mcpServers: [],
        permissionPolicy: { allowWritesUnder: ['/workspace/app'], allowCommands: false },
      }),
      sandbox,
    );
    const seen: KiroEvent[] = [];
    const drain = (async () => {
      for await (const e of session.events()) seen.push(e);
    })();
    await session.prompt(prompt);
    await session.close();
    await drain;
    const decisions = seen.filter((e) => e.type === 'permission_request');
    expect(decisions.length).toBe((attacks[name] ?? []).length);
    expect(
      decisions.every((e) => e.type === 'permission_request' && e.decision === 'rejected'),
    ).toBe(true);
    for (const r of server.permissionReplies)
      expect((r as { outcome: { optionId: string } }).outcome.optionId).toBe('reject_once');
  });
});
