/**
 * `pnpm new-app <name>` (task P1-07): copies templates/app-starter to apps/<name>
 * and renames it. Runs with Node's built-in type stripping, so it uses only
 * erasable TypeScript and Node built-ins.
 *
 * Renames: the package name `@lathe/app-starter`, the slug `app-starter`
 * (contract, seed emails, migration file prefix) and the title `App Starter`.
 * The template's fixed demo org ids are replaced with fresh ones, so two apps
 * seeded into one database do not collide.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEMPLATE_SLUG = 'app-starter';
export const TEMPLATE_TITLE = 'App Starter';
/** Demo org ids in the template's seed data. Each generated app gets new ones. */
export const TEMPLATE_ORG_IDS = [
  '6f1d8a52-0b4e-4c61-9a57-3e2b1c9d0a01',
  '6f1d8a52-0b4e-4c61-9a57-3e2b1c9d0b02',
];

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const RESERVED = new Set(['workspace', TEMPLATE_SLUG, 'node_modules']);
const SKIP_DIRS = new Set(['node_modules', '.next', 'coverage', 'dist', '.turbo']);
const SKIP_FILES = /(^next-env\.d\.ts$|\.tsbuildinfo$)/;

/** Returns an error message, or null when `name` can be an app name. */
export function checkName(name: string): string | null {
  if (name.length < 3 || name.length > 40) return 'the name must have 3 to 40 characters';
  if (!NAME.test(name)) {
    return 'use lowercase letters, digits and single hyphens, starting with a letter (for example support-desk)';
  }
  if (RESERVED.has(name)) return `${name} is reserved`;
  return null;
}

export const titleOf = (name: string): string =>
  name
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/** Applies the renames to one file's text. `orgIds` replaces TEMPLATE_ORG_IDS in order. */
export function transform(text: string, name: string, orgIds: readonly string[]): string {
  let out = text
    .replaceAll(`@lathe/${TEMPLATE_SLUG}`, `@lathe/${name}`)
    .replaceAll(TEMPLATE_TITLE, titleOf(name))
    .replaceAll(TEMPLATE_SLUG, name);
  TEMPLATE_ORG_IDS.forEach((id, i) => {
    const next = orgIds[i];
    if (next === undefined) throw new Error('an org id is missing');
    out = out.replaceAll(id, next);
  });
  return out;
}

export const renamePath = (path: string, name: string): string =>
  path.replaceAll(TEMPLATE_SLUG, name);

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
      } else if (!SKIP_FILES.test(entry.name)) {
        out.push(relative(root, full).split(sep).join('/'));
      }
    }
  };
  await walk(root);
  return out.sort();
}

export interface NewAppOptions {
  readonly repoRoot: string;
  readonly name: string;
  readonly newId?: () => string;
}

/** Creates apps/<name>. Returns the files written, relative to the new app. */
export async function newApp(options: NewAppOptions): Promise<string[]> {
  const problem = checkName(options.name);
  if (problem) throw new Error(`invalid app name: ${problem}`);
  const template = join(options.repoRoot, 'templates', TEMPLATE_SLUG);
  const target = join(options.repoRoot, 'apps', options.name);
  if (!existsSync(template)) throw new Error('templates/app-starter not found');
  if (existsSync(target)) throw new Error(`apps/${options.name} already exists`);

  const newId = options.newId ?? randomUUID;
  const orgIds = TEMPLATE_ORG_IDS.map(() => newId());
  const files = await listFiles(template);
  const written: string[] = [];
  try {
    for (const file of files) {
      const text = await readFile(join(template, file), 'utf8');
      const dest = renamePath(file, options.name);
      const full = join(target, dest);
      await mkdir(dirname(full), { recursive: true });
      // `wx`: never overwrite a file that appeared meanwhile.
      await writeFile(full, transform(text, options.name, orgIds), { flag: 'wx' });
      written.push(dest);
    }
  } catch (error) {
    // Remove only the directory this run created.
    await rm(target, { recursive: true, force: true });
    throw error;
  }
  return written;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const name = process.argv[2] ?? '';
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  newApp({ repoRoot, name })
    .then((files) => {
      console.log(`Created apps/${name} (${files.length} files). Next steps:`);
      console.log('  pnpm install');
      console.log(`  pnpm --filter @lathe/${name} migrate`);
      console.log(`  pnpm --filter @lathe/${name} seed`);
      console.log(`  pnpm --filter @lathe/${name} dev`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'new-app failed');
      process.exitCode = 1;
    });
}
