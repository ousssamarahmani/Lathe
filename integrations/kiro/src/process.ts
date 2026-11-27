import { spawn as nodeSpawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { SandboxHandle, SessionRequest } from '@lathe/shared-contracts';

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  /** Set when the process could not be started or crashed on spawn. */
  error?: string;
}

/** The child side of an ACP connection: newline-delimited JSON-RPC over stdio. */
export interface AcpProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr?: Readable;
  /** Terminates the process. Safe to call more than once. */
  kill(): void;
  /** Called once, after the process ended and stdout is drained. */
  onExit(listener: (info: ExitInfo) => void): void;
}

export interface SpawnContext {
  command: string;
  args: readonly string[];
  /** Already filtered by the adapter's allow-list. Never the host environment. */
  env: Readonly<Record<string, string>>;
  sandbox: SandboxHandle;
  request: SessionRequest;
}

/** Injected so tests never start the real CLI. P4-02 supplies the sandboxed implementation. */
export type SpawnFn = (context: SpawnContext) => AcpProcess;

/**
 * Runs the command directly on the host with the filtered environment. Only for the
 * real-CLI smoke script. The sandbox runner (P4-02) replaces it for real runs.
 */
export const hostSpawn: SpawnFn = ({ command, args, env }) => {
  const child = nodeSpawn(command, [...args], {
    env: { ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let listener: ((info: ExitInfo) => void) | undefined;
  let final: ExitInfo | undefined;
  let delivered = false;
  const deliver = (): void => {
    if (delivered || !listener || !final) return;
    delivered = true;
    listener(final);
  };
  child.on('error', (err) => {
    final ??= { code: null, signal: null, error: err.message };
    deliver();
  });
  child.on('close', (code, signal) => {
    final ??= { code, signal };
    deliver();
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => {
      child.kill();
    },
    onExit: (l) => {
      listener = l;
      deliver();
    },
  };
};
