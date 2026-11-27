export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command to completion without a shell. Injected so tests never start Docker. */
export interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: { env?: Readonly<Record<string, string>>; cwd?: string },
  ): Promise<CommandResult>;
}
