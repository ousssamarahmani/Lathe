import { VERIFY_EXIT_CODES } from '@lathe/shared-contracts';
import { main, type CliDeps } from './cli.js';

/**
 * Process entry for `lathe-verify`. Any unexpected throw (for example the report
 * path is a directory) becomes exit 2 (`error`), never 1 (`failed`): a harness
 * crash must not look like failing code, or the repair loop would "fix" code
 * that is not broken.
 */
export async function run(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  try {
    return await main(argv, deps);
  } catch (error) {
    const stderr = deps.stderr ?? ((line: string) => void process.stderr.write(`${line}\n`));
    stderr(
      `lathe-verify: internal error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return VERIFY_EXIT_CODES.error;
  }
}
