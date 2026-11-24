// Tests of `pnpm new-app` (task P1-07), run against a copy of the real template.
import { cp, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEMPLATE_ORG_IDS, checkName, newApp, titleOf, transform } from './new-app.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
let root;

async function filesUnder(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(relative(dir, join(e.parentPath, e.name)).split(sep).join('/'));
  }
  return out.sort();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lathe-new-app-'));
  await cp(join(repo, 'templates', 'app-starter'), join(root, 'templates', 'app-starter'), {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|\.next)([\\/]|$)/.test(src),
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('checkName', () => {
  it.each(['support-desk', 'team-operations', 'abc', 'a1-b2'])('accepts %s', (n) => {
    expect(checkName(n)).toBeNull();
  });
  it.each([
    '',
    'ab',
    'Support',
    '-desk',
    'desk-',
    'a--b',
    'a_b',
    '../evil',
    'a/b',
    'workspace',
    'app-starter',
    'x'.repeat(41),
  ])('rejects %j', (n) => {
    expect(checkName(n)).not.toBeNull();
  });
});

describe('transform', () => {
  it('renames package, slug and title, and replaces the org ids', () => {
    const text = `@lathe/app-starter app-starter App Starter ${TEMPLATE_ORG_IDS.join(' ')}`;
    expect(transform(text, 'support-desk', ['id-1', 'id-2'])).toBe(
      '@lathe/support-desk support-desk Support Desk id-1 id-2',
    );
    expect(titleOf('team-operations')).toBe('Team Operations');
  });
});

describe('newApp', () => {
  it('copies the template to apps/<name> with every trace of the template name replaced', async () => {
    let n = 0;
    const written = await newApp({
      repoRoot: root,
      name: 'support-desk',
      newId: () => `00000000-0000-4000-8000-00000000000${(n += 1)}`,
    });
    const app = join(root, 'apps', 'support-desk');
    const files = await filesUnder(app);
    expect(files).toEqual([...written].sort());
    expect(files).toContain('migrations/support-desk_0001_notes.sql');
    expect(files).toContain('src/server/notes.ts');
    expect(files.some((f) => f.includes('app-starter'))).toBe(false);
    expect(files.some((f) => /node_modules|\.next\/|tsbuildinfo/.test(f))).toBe(false);

    const pkg = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@lathe/support-desk');
    for (const f of files) {
      const text = await readFile(join(app, f), 'utf8');
      expect(text, f).not.toContain('app-starter');
      expect(text, f).not.toContain('App Starter');
      // The generator only renames 'app-starter'; a derived form would keep the old name.
      expect(text, f).not.toContain('app_starter');
      for (const id of TEMPLATE_ORG_IDS) expect(text, f).not.toContain(id);
    }
    const seed = await readFile(join(app, 'src/server/seed-data.ts'), 'utf8');
    expect(seed).toContain('00000000-0000-4000-8000-000000000001');
    expect(seed).toContain('00000000-0000-4000-8000-000000000002');
    const slug = await readFile(join(app, 'src/server/app-slug.ts'), 'utf8');
    expect(slug).toContain("APP_SLUG = 'support-desk'");
    // The contract names the new app and the seed variable C1 allows.
    const contract = await readFile(join(app, 'src/tenant-contract.ts'), 'utf8');
    expect(contract).toContain('app: APP_SLUG');
    expect(contract).toContain("passwordEnv: 'LATHE_TEST_PASSWORD'");
  });

  it('gives each generated app different org ids by default', async () => {
    await newApp({ repoRoot: root, name: 'first-app' });
    await newApp({ repoRoot: root, name: 'second-app' });
    const ids = async (name) =>
      (await readFile(join(root, 'apps', name, 'src/server/seed-data.ts'), 'utf8')).match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      );
    const a = await ids('first-app');
    const b = await ids('second-app');
    expect(a).toHaveLength(2);
    expect(a?.some((id) => b?.includes(id))).toBe(false);
  });

  it('refuses an existing app and leaves it untouched', async () => {
    await newApp({ repoRoot: root, name: 'support-desk' });
    const pkg = join(root, 'apps', 'support-desk', 'package.json');
    const before = (await stat(pkg)).mtimeMs;
    await expect(newApp({ repoRoot: root, name: 'support-desk' })).rejects.toThrow(
      /already exists/,
    );
    expect((await stat(pkg)).mtimeMs).toBe(before);
  });

  it('refuses an invalid name before writing anything', async () => {
    await expect(newApp({ repoRoot: root, name: '../escape' })).rejects.toThrow(/invalid app name/);
    await expect(readdir(join(root, 'apps'))).rejects.toThrow();
  });
});
