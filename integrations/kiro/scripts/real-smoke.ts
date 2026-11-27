/**
 * Real-CLI smoke test for the ACP adapter. NOT run by `pnpm test`: it needs a logged-in
 * `kiro-cli` (mode B, ADR 0003) and starts the CLI on the machine it runs on, with no
 * sandbox. C2 fixes the session cwd to a `/workspace/...` path, so run it where
 * `/workspace/app` exists (for example inside the P0-04 spike container, once P4-02
 * provides the sandboxed `SpawnFn`), on a trusted machine:
 *
 *   pnpm --filter @lathe/kiro-integration real-smoke
 *
 * The CLI finds its login session through HOME, so HOME is the only variable passed.
 * No permission policy is set, so every tool permission request is rejected: the
 * prompt asks for a plain reply. The script prints event type counts only, never
 * message text, tool payloads or tokens.
 */
import { SessionRequest, type SandboxHandle } from '@lathe/shared-contracts';
import { AcpKiroAdapter } from '../src/index.js';

const adapter = new AcpKiroAdapter({
  envAllowlist: ['HOME', 'PATH'],
  handshakeTimeoutMs: 60_000,
  promptTimeoutMs: 180_000,
});

// No sandbox in this smoke. A stub handle satisfies the interface.
const sandbox = { id: 'host-smoke' } as unknown as SandboxHandle;

const request = SessionRequest.parse({
  runId: crypto.randomUUID(),
  agentProfile: 'builder',
  cwd: '/workspace/app',
  prompt: 'Reply with the single word: pong. Do not use any tool.',
  timeoutMs: 240_000,
  mcpServers: [],
});

const session = await adapter.start(request, sandbox);
let exitCode: number;
try {
  const result = await session.prompt(request.prompt);
  await session.close();
  const counts: Record<string, number> = {};
  for await (const e of session.events()) counts[e.type] = (counts[e.type] ?? 0) + 1;
  console.log(JSON.stringify({ stopReason: result.stopReason, events: counts }));
  exitCode = result.stopReason === 'end_turn' ? 0 : 1;
} finally {
  await session.close();
}
process.exit(exitCode);
