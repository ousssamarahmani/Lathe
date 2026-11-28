/**
 * Validates the runtime agent configs with the pinned Kiro CLI inside the sandbox image.
 * NOT run by `pnpm test`: needs Docker, the image `lathe/sandbox:p4-02` and a logged-in CLI
 * (`kiro agent validate` refuses to run without a login). Exits 2 when it cannot run.
 *
 *   node --experimental-strip-types scripts/check-agents.ts   (cwd: integrations/kiro)
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const IMAGE = process.env['LATHE_SANDBOX_IMAGE'] ?? 'lathe/sandbox:p4-02';
const agents = resolve(fileURLToPath(import.meta.url), '../../agents');
const docker = (args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });

if (docker(['image', 'inspect', IMAGE]).status !== 0) {
  console.error(`not run: image ${IMAGE} not found`);
  process.exit(2);
}
let failed = false;
for (const name of ['planner', 'builder', 'repair']) {
  const r = docker([
    'run',
    '--rm',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--network',
    'none',
    '-v',
    `${agents}:/a:ro`,
    '--entrypoint',
    'kiro-cli',
    IMAGE,
    'agent',
    'validate',
    '--path',
    `/a/${name}.json`,
  ]);
  const out = `${r.stdout}${r.stderr}`.trim().split('\n')[0] ?? '';
  if (/not logged in/i.test(out)) {
    console.error('not run: kiro-cli needs a login (agent validate)');
    process.exit(2);
  }
  console.log(`${name}: ${r.status === 0 ? 'ok' : 'FAILED'} ${r.status === 0 ? '' : out}`);
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
