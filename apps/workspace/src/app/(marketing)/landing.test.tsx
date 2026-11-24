import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ALL_CLAIMS, REPO_URL } from './content';
import LandingPage from './page';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..', '..');

afterEach(cleanup);

function pageText(): string {
  render(<LandingPage />);
  return document.body.textContent ?? '';
}

describe('claims (docs/design/landing-claims.md)', () => {
  it('every evidence path exists in the repository', () => {
    const missing = ALL_CLAIMS.flatMap((c) =>
      c.evidence
        .filter((e) => !e.startsWith('https://'))
        .filter((e) => !existsSync(join(repoRoot, e)))
        .map((e) => `${c.id}: ${e}`),
    );
    expect(missing).toEqual([]);
  });

  it('only in-review claims may cite a pull request instead of a file', () => {
    const offenders = ALL_CLAIMS.filter(
      (c) => c.status !== 'in-progress' && c.evidence.some((e) => e.startsWith('https://')),
    ).map((c) => c.id);
    expect(offenders).toEqual([]);
  });

  it('every claim has evidence and a unique id', () => {
    expect(ALL_CLAIMS.filter((c) => c.evidence.length === 0).map((c) => c.id)).toEqual([]);
    const ids = ALL_CLAIMS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('landing-claims.md lists every claim id with its status', () => {
    const doc = readFileSync(join(repoRoot, 'docs', 'design', 'landing-claims.md'), 'utf8');
    const label = { built: 'Built and tested', 'in-progress': 'In review', planned: 'Planned' };
    const rows = new Map(
      [...doc.matchAll(/^\| `([a-z0-9-]+)` \|[^|]*\| ([^|]+) \|/gm)].map((m) => [
        m[1] ?? '',
        (m[2] ?? '').trim(),
      ]),
    );
    const problems = ALL_CLAIMS.filter((c) => rows.get(c.id) !== label[c.status]).map(
      (c) => `${c.id}: page says "${label[c.status]}", doc says "${rows.get(c.id) ?? 'missing'}"`,
    );
    expect(problems).toEqual([]);
  });
});

describe('content rules', () => {
  it('has no pricing', () => {
    expect(pageText()).not.toMatch(/pric(e|ing)|\$\s?\d|per month|\/mo\b|subscription|free trial/i);
  });

  it('makes no production-ready or deployment claim', () => {
    expect(pageText()).not.toMatch(/production[- ]ready|deploy/i);
  });

  it('shows the status of every claim', () => {
    render(<LandingPage />);
    const shown = document.querySelectorAll('[data-status]');
    // One per claim card plus the workflow section.
    expect(shown.length).toBe(ALL_CLAIMS.length);
  });

  it('has the hero title as the only h1', () => {
    render(<LandingPage />);
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s.map((h) => h.textContent)).toEqual(['Your Mini Software Factory']);
  });
});

describe('links', () => {
  function links(): string[] {
    render(<LandingPage />);
    return [...document.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
  }

  it('every in-page anchor points at an element on the page', () => {
    const hrefs = links();
    const broken = hrefs
      .filter((h) => h.startsWith('#'))
      .filter((h) => !document.getElementById(h.slice(1)));
    expect(broken).toEqual([]);
  });

  it('every repository link points at a file or folder that exists', () => {
    const prefix = `${REPO_URL}/`;
    const broken = links()
      .filter((h) => /^https:\/\/github\.com\/Lathedottech\/Lathe\/(blob|tree)\/main\//.test(h))
      .map((h) => h.slice(prefix.length).replace(/^(blob|tree)\/main\//, ''))
      .filter((p) => !existsSync(join(repoRoot, p)));
    expect(broken).toEqual([]);
  });

  it('links only to the page itself or the Lathe repository', () => {
    const outside = links().filter(
      (h) =>
        !(
          h.startsWith('#') ||
          h === '/' ||
          h === REPO_URL ||
          h.startsWith(`${REPO_URL}/`) ||
          h.startsWith(`${REPO_URL}#`)
        ),
    );
    expect(outside).toEqual([]);
  });
});

describe('no Engine calls from marketing routes', () => {
  const files = readdirSync(here).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.tsx'));

  it('marketing route files do not fetch, stream or reference the Engine API', () => {
    const offenders = files.flatMap((f) => {
      const text = readFileSync(join(here, f), 'utf8');
      return [
        /\bfetch\s*\(/,
        /EventSource/,
        /XMLHttpRequest/,
        /['"`]\/v1\//,
        /process\.env/,
        /['"]use client['"]/,
      ]
        .filter((re) => re.test(text))
        .map((re) => `${f}: ${re}`);
    });
    expect(offenders).toEqual([]);
  });

  it('marketing route files import only content, styles, UI components and Next types', () => {
    const imports = files.flatMap((f) =>
      [...readFileSync(join(here, f), 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1] ?? ''),
    );
    const allowed = /^(\.\/content|\.\/page\.module\.css|\.\.\/\.\.\/components\/ui|next)$/;
    expect(imports.filter((i) => !allowed.test(i))).toEqual([]);
  });
});
