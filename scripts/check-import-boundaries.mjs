#!/usr/bin/env node
// Runs dependency-cruiser with .dependency-cruiser.mjs over the first-party
// folders that exist (task P0-10). Part of `pnpm lint`.
//
// Usage: node scripts/check-import-boundaries.mjs [--cwd <dir>] [-- <extra depcruise args>]
// `--cwd` is for the fixture tests: it runs the same rules against another tree.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Where first-party code lives. Scanning `.` would walk node_modules. */
const ROOTS = ['packages', 'apps', 'services', 'integrations', 'templates', 'scripts', 'tests'];

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const sep = args.indexOf('--');
const own = sep === -1 ? args : args.slice(0, sep);
const extra = sep === -1 ? [] : args.slice(sep + 1);

const cwdFlag = own.indexOf('--cwd');
const cwd = cwdFlag === -1 ? repo : resolve(own[cwdFlag + 1] ?? '.');
const targets = ROOTS.filter((dir) => existsSync(join(cwd, dir)));
if (targets.length === 0) {
  process.stderr.write(`check-import-boundaries: no first-party folder found in ${cwd}\n`);
  process.exit(2);
}

const result = spawnSync(
  process.execPath,
  [
    join(repo, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs'),
    ...targets,
    '--config',
    join(repo, '.dependency-cruiser.mjs'),
    ...(extra.includes('--output-type') ? [] : ['--output-type', 'err']),
    ...extra,
  ],
  { cwd, stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exit(result.status ?? 2);
