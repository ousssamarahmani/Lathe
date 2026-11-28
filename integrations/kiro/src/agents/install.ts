/**
 * Installs a runtime agent config and its steering into a sandbox work directory (task P4-04).
 * The target is `<workDir>/.kiro/`; the host repository is never written. The config is
 * validated first and refused when it names an unknown tool, any MCP server, or a write
 * path outside `/workspace/app`.
 */
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentProfile } from '@lathe/shared-contracts';
import { z } from 'zod';

export const AGENT_TOOLS = ['fs_read', 'fs_write'] as const;
const Tool = z.enum(AGENT_TOOLS);
const READ_PATHS = ['/workspace/app/**', '/workspace/application-foundation/**'] as const;
const WRITE_PATHS = ['/workspace/app/**'] as const;

const AllowedPaths = (allowed: readonly string[]) =>
  z.strictObject({
    allowedPaths: z
      .array(z.string())
      .min(1)
      .refine((p) => p.every((x) => allowed.includes(x)), 'path outside the allowed roots'),
  });

export const AgentConfig = z
  .strictObject({
    name: AgentProfile,
    description: z.string().min(1).max(300),
    prompt: z.string().min(1).max(4_000),
    /** Kiro's object form of the server list. Only the empty object validates. */
    mcpServers: z.strictObject({}),
    includeMcpJson: z.literal(false),
    tools: z.array(Tool).min(1),
    allowedTools: z.array(Tool).min(1),
    toolsSettings: z.strictObject({
      fs_read: AllowedPaths(READ_PATHS).optional(),
      fs_write: AllowedPaths(WRITE_PATHS).optional(),
    }),
    resources: z.array(z.string().regex(/^file:\/\/\.kiro\/steering\/[a-z-]+\.md$/)).min(1),
  })
  .superRefine((c, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (c.allowedTools.some((t) => !c.tools.includes(t))) issue('allowedTools must be in tools');
    const writes = c.tools.includes('fs_write') || c.allowedTools.includes('fs_write');
    if (c.name === 'planner' && writes) issue('the planner has no write tool');
    if (writes && !c.toolsSettings.fs_write) issue('fs_write needs allowedPaths');
    if (!writes && c.toolsSettings.fs_write) issue('fs_write settings without the tool');
  });
export type AgentConfig = z.infer<typeof AgentConfig>;

export const DEFAULT_AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../agents');

export async function loadAgentConfig(
  profile: AgentProfile,
  agentsDir: string = DEFAULT_AGENTS_DIR,
): Promise<AgentConfig> {
  const name = AgentProfile.parse(profile);
  const raw: unknown = JSON.parse(await readFile(join(agentsDir, `${name}.json`), 'utf8'));
  const config = AgentConfig.parse(raw);
  if (config.name !== name) throw new Error(`agent file ${name}.json declares ${config.name}`);
  return config;
}

/** Copies the validated config and its steering to `<workDir>/.kiro/`. Returns the files written. */
export async function installAgent(
  profile: AgentProfile,
  workDir: string,
  agentsDir: string = DEFAULT_AGENTS_DIR,
): Promise<string[]> {
  if (!isAbsolute(workDir)) throw new Error('workDir must be an absolute path');
  const config = await loadAgentConfig(profile, agentsDir);
  const kiro = join(resolve(workDir), '.kiro');
  const written: string[] = [];
  const put = async (from: string, to: string): Promise<void> => {
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    written.push(to);
  };
  await put(join(agentsDir, `${config.name}.json`), join(kiro, 'agents', `${config.name}.json`));
  for (const r of config.resources) {
    const file = r.slice('file://.kiro/steering/'.length);
    await put(join(agentsDir, 'steering', file), join(kiro, 'steering', file));
  }
  return written;
}
