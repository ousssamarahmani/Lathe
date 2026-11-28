# P4-04 Runtime agent configs: kiro-integration report

## 1. Objective completed
P4-04, partially completed. Configs, install, tests and injection regression are done. The real-CLI load check was not run (needs a Kiro login).

## 2. Files created or modified
- `integrations/kiro/agents/{planner,builder,repair}.json`
- `integrations/kiro/agents/steering/{common,planner,builder,repair}.md`
- `integrations/kiro/src/agents/{install.ts,index.ts,install.test.ts}`, export added in `src/index.ts`
- `integrations/kiro/fixtures/prompt-injection/*.txt` (4 files)
- `integrations/kiro/scripts/check-agents.ts`
- `docs/reports/P4-04-kiro-integration.md`

## 3. Technical decisions
- Zod `AgentConfig` is strict: tools limited to `fs_read` and `fs_write`, empty `mcpServers`, `includeMcpJson: false`, write paths only `/workspace/app/**`, planner cannot hold a write tool. Rejected: a free-form tool list checked at runtime by Kiro.
- Install copies only the config and its steering into `<workDir>/.kiro/`. Rejected: copying the whole agents directory.
- Injection tests send the tool request a compliant agent would make through the real adapter permission policy and the fake ACP server. Rejected: scoring model replies, which is nondeterministic.
- `execute` is never listed; the adapter policy also denies it.

## 4. Tests executed
- `pnpm install --frozen-lockfile`
- `pnpm typecheck`, `pnpm lint`, `pnpm test`
- `pnpm exec prettier --check integrations docs`
- `node --experimental-strip-types scripts/check-agents.ts` (cwd `integrations/kiro`)

## 5. Test results
- install: exit 0. typecheck: exit 0. lint: exit 0. prettier: exit 0.
- test: 47 files passed, 648 tests passed, 5 skipped (653), exit 0.
- check-agents: exit 2, `not run: kiro-cli needs a login (agent validate)`. Docker 29.9.2 was up and image `lathe/sandbox:p4-02` exists.

## 6. Remaining issues
- "Configs load in the pinned CLI" is unverified until a human logs in; then run the check-agents script.
- The injection tests check the adapter policy, not live model behavior.
- Steering text is checked by keyword only.

## 7. Dependencies or blockers
Stacked on #33 (P4-01 adapter) and the P4-02 sandbox. `security` review is required (sandbox and agent config).

## 8. Recommended next task
Human runs the CLI login, then check-agents. After that, P4-05 or the pipeline wiring that calls `installAgent`.
