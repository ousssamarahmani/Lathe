#!/usr/bin/env node
// Runs the TypeScript CLI without a build step: workspace packages export TypeScript sources.
// A failure to load the CLI is a harness error: exit 2, never 1 (see src/entry.ts).
import process from 'node:process';

try {
  const { register } = await import('tsx/esm/api');
  register();
  await import('../src/bin.ts');
} catch (error) {
  process.stderr.write(
    `lathe-verify: cannot start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
