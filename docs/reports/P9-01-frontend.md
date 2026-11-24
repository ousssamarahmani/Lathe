# P9-01 Public landing page, skeleton (frontend)

Person: B. Branch: `task/P9-01-landing`, from `origin/task/P9-00-design-system`, with `origin/main` (`7e2e640`) merged in. Date: 2026-11-22.

## 1. Objective completed

P9-01, **partially completed: the skeleton (due Nov 22)**. The final page is due Dec 1. The landing page is live at `/` in `apps/workspace` (route group `(marketing)`): navigation, hero, workflow, what exists today, architecture, Kiro story, final call to action and footer. Every statement comes from one file, `content.ts`, and each claim cites the repository artifact that proves it, with a visible status (Built and tested, In review, Planned). `docs/design/landing-claims.md` lists every claim for person A's sign-off.

Not done yet (final page, by Dec 1): the Support Desk and Team Operations showcase and real screenshots (the apps and Workspace screens do not exist), Playwright at desktop and mobile widths, "Watch demo" (no video yet), loading the fonts.

## 2. Files created or modified

New:
- `apps/workspace/src/app/(marketing)/page.tsx`: the page.
- `apps/workspace/src/app/(marketing)/content.ts`: all copy, every claim with status and evidence.
- `apps/workspace/src/app/(marketing)/page.module.css`: tokens only.
- `apps/workspace/src/app/(marketing)/landing.test.tsx`: 13 tests.
- `docs/design/landing-claims.md`: claims register.

Modified: `.gitattributes` (`*.css` forced to LF; see section 3).

## 3. Technical decisions

- **One source for all copy** (`content.ts`). The page renders only from it, so a sentence cannot reach the page without a claim entry. Rejected: copy in JSX with a separate claims list, which drifts.
- **Status on every claim.** Lathe is pre-alpha: the Engine, delivery and the full loop do not run yet. The page says so per item instead of describing the target as if it existed. `landing-claims.md` defines the three statuses; Built means merged on `main` with tests.
- **Built claims cite files; only In review claims may cite a pull request.** The harness is In review (PR #5, with the P2-02 parser fix still open) and must not move to Built before it merges.
- **Sections left out**: Support Desk and Team Operations showcase, screenshots and "Watch demo" (task text requires real captures and an existing video). Listed in `landing-claims.md`.
- **"Ship" is defined on the page** as a draft pull request with evidence that a human reviews and merges, never a deployment (D19).
- **Links go only to the page itself or the `Lathedottech/Lathe` repository.** "Get started" links to the README quickstart, as the task requires.
- **Static and server-rendered.** No `'use client'`, no `fetch`, no `/v1/` reference, no `process.env` in marketing route files; the build pre-renders `/` as a static page.
- **Accessibility**: skip link to `#main`, one `h1`, labelled sections, labelled navigation, workflow as an ordered list, links styled as links (no buttons for navigation).
- **`.gitattributes`: `*.css text eol=lf`.** After the mutation runs, Git reported every CSS file as modified: they are stored with LF, and `core.autocrlf` checked them out with CRLF once rewritten. Same class of problem as `eslint.config.js` in P0-06. The content of the files is unchanged.

## 4. Tests executed

Windows, Node v24.14.0, pnpm 9.15.9.

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
$env:NEXT_TELEMETRY_DISABLED = '1'; pnpm --filter @lathe/workspace run build
# mutations: each edits one file, runs
#   pnpm exec vitest run 'src/app' 'src/styles/no-raw-colors.test.ts'
# in apps/workspace, and restores the file
```

## 5. Test results

| Command | Result | Exit |
|---|---|---|
| `pnpm install --frozen-lockfile` | ok, after merging `main` into the branch (no conflicts) | 0 |
| `pnpm typecheck` | all packages | 0 |
| `pnpm lint` | clean | 0 |
| `pnpm test` | `Test Files 16 passed (16)`, `Tests 202 passed (202)` (13 new) | 0 |
| `pnpm format:check` | clean | 0 |
| `next build` | `Compiled successfully`; prerender manifest lists `/` and `/design-system` as static | 0 |

The 13 landing tests: every evidence path exists in the repository; only In review claims cite a pull request; every claim has evidence and a unique id; `landing-claims.md` lists every claim id with the same status as the page; no pricing words; no "production ready" or deploy wording; every claim shows its status; one `h1`, the hero title; every in-page anchor has a target; every repository link points at a file or folder that exists; links go only to the page or the repository; marketing route files contain no `fetch`, `EventSource`, `XMLHttpRequest`, `/v1/`, `process.env` or `'use client'`; marketing route files import only content, styles, UI components and Next.

Mutations (each restored afterwards):

| Mutation | Result |
|---|---|
| "Free trial, then $29 per month" added to the hero | 1 failed: no pricing |
| "then Lathe deploys it" added to the Ship step | 1 failed: no deployment claim |
| evidence file that does not exist | 2 failed: evidence exists, repository links exist |
| a Built claim citing only a pull request | 1 failed: only In review may cite a pull request |
| Factory Engine set to Built on the page only | 1 failed: claims doc status matches |
| navigation anchor to a missing section | 1 failed: in-page anchors |
| footer link to an outside site | 1 failed: links only to the page or repository |
| `fetch('…/v1/overview')` in the page | 1 failed: no Engine calls |
| a raw hex color in the landing CSS | 1 failed: tokens only (P9-00 test) |

The first mutation run was interrupted after one mutation and left the broken anchor in `content.ts`; I found it with a scan for every mutation string, restored it, and re-ran the mutations one at a time. The numbers above are from that second run.

Not run: a live HTTP request to `next start` (the request hung on this machine; the build manifest confirms the static route). Playwright: part of the final page.

## 6. Remaining issues

- **Branch base.** This branch is built on `task/P9-00-design-system`, which is in review. Merge P9-00 first.
- **Sign-off.** Every row in `landing-claims.md` is "pending"; person A signs off before Dec 1.
- **Copy will change** as tasks land: the harness moves to Built when PR #5 merges; Engine, delivery and the workflow when P3 to P5 do.
- **Scope question for person A**: his Nov 21 update says to reduce the landing page to essentials. This skeleton has no separate "What Lathe is" section; capabilities are shown as evidence cards. Cutting the architecture or capability cards is a small change.
- Fonts not loaded (system fallbacks). No icons or brand image.

## 7. Dependencies or blockers

- P9-00 review and merge (base of this branch).
- Person A: claims sign-off; scope confirmation.
- Final page needs P6-01/P7-02 (apps), P9-03/P9-06 (screenshots), P10-04 (video).

## 8. Recommended next task

P7-01 hierarchical scopes (unblocked since P1-05 merged), then the final landing page items as their dependencies land.
