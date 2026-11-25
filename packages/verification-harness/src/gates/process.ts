import { spawn, spawnSync } from 'node:child_process';

export interface CommandSpec {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}
export interface CommandResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** Last part of stdout and stderr, already redacted. */
  readonly output: string;
  /** Set when the process could not start. */
  readonly spawnError?: string;
}
/** Runs a command as a process. Injected into gates so tests never need real builds. */
export type CommandRunner = (spec: CommandSpec) => Promise<CommandResult>;

const MAX_OUTPUT = 64_000;
/** Only these variables reach the app's build and test processes. No credentials. */
const ENV_ALLOW = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR'];

export function redact(text: string): string {
  return text.replace(
    /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|authorization)[A-Za-z0-9_.-]*)\s*[=:]\s*\S+/gi,
    '$1=[redacted]',
  );
}

export function tail(text: string, max: number): string {
  return text.length <= max ? text : `...${text.slice(text.length - max)}`;
}

/** With `shell: true` Node joins arguments unquoted, so quote any that cmd.exe would split or interpret. */
function winQuote(arg: string): string {
  return /[\s&|<>^()"%]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: '1' };
  for (const k of ENV_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

export const runCommand: CommandRunner = (spec) =>
  new Promise((resolve) => {
    const win = process.platform === 'win32';
    // Arguments are constants from the policy file, never agent input, so the Windows shell is safe.
    const args = win ? spec.args.map(winQuote) : [...spec.args];
    const child = spawn(spec.cmd, args, {
      cwd: spec.cwd,
      env: cleanEnv(),
      shell: win,
      detached: !win,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let timedOut = false;
    let done = false;
    const onData = (d: Buffer): void => {
      buf = tail(buf + d.toString('utf8'), MAX_OUTPUT);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const kill = (): void => {
      if (child.pid === undefined) return;
      if (win) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f']);
      else process.kill(-child.pid, 'SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, spec.timeoutMs);
    const finish = (r: CommandResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.on('error', (e) =>
      finish({ exitCode: null, timedOut: false, output: '', spawnError: e.message }),
    );
    child.on('close', (code) => finish({ exitCode: code, timedOut, output: redact(buf) }));
  });
