# Report: P6-01 Support Desk scaffold, roles, tickets, assignments (backend)

Branch `task/P6-01-support-desk`, from `task/P1-07-template` at `1449190` (P1-07 not merged yet;
it contains the C1 v1 of PR #18).

## 1. Objective completed

P6-01 **completed, pending review** (architect). `apps/support-desk` generated with
`pnpm new-app support-desk`, then: roles requester / agent / admin (plus the foundation's owner),
ticket create / read / list / update, status and priority triage, assignment, comments with
staff-only internal notes, its C1 contract, seed, and tests. Acceptance "Harness passes" is **not
run**: the harness suites (P2-04, P2-05, P2-06) are not merged (section 6).

## 2. Files created or modified

- `apps/support-desk/**` (new; generated from the template, then):
  `src/server/{authz,schema,tickets}.ts`, `migrations/support-desk_0001_tickets.sql`,
  `src/app/v1/tickets/**` (4 route files), `src/app/(app)/tickets/**` (list and detail pages),
  `src/app/_components/forms.tsx` (ticket, controls, reply forms), `src/tenant-contract.ts` and
  test, `src/server/{config.test,app.integration.test}.ts`, `e2e/smoke.spec.ts`, `README.md`.
  The template's `notes` resource, routes and pages were removed.
- `templates/app-starter/src/server/app.integration.test.ts`: random client address per sign-in
  (the fixed counter hit the sign-in rate limit on repeated runs, see section 5).
- `pnpm-lock.yaml` (new workspace package).

## 3. Technical decisions

| Decision | Rejected alternative | Reason |
|---|---|---|
| Keep `owner` beside requester / agent / admin; only owner has `members.manage` | Three roles only | The foundation makes the org creator `owner` and keeps one; with admin ⊂ owner no admin can demote an owner (`isWithin`) |
| Requester visibility by permission `tickets.read_all` in the query (`visible(ctx)`) | A per-user RLS policy | `withTenant` sets only the org; a user policy needs `app.user_id` inside tenant transactions, a foundation change. Defense in depth stays org RLS + org filter; the rule is tested |
| Hidden ticket → 404 | 403 | Same answer as "does not exist" and "other org" |
| No ticket deletion; comments immutable (REVOKE for the app role) | Delete endpoints | Support history is a record; the database enforces it (tested) |
| Assignee is a membership, composite FK `(org_id, assignee_membership_id)` | User id | Cross-org assignment is impossible in the database; leaving the org clears the assignment (`ON DELETE SET NULL (assignee_membership_id)`) |
| Assignee must hold `tickets.read_all` | Any member | A requester must not receive other people's tickets |
| A closed ticket only reopens; no replies or edits while closed | Free edits | Predictable life cycle; `closed_at` is consistent with the status by a CHECK |
| Assign and add-comment routes not declared in C1, listed in `UNDECLARED_ROUTES`; `ticket_comments` not declared as a tenant table | Declare them anyway | C1 v1 cannot describe a body with a staff membership id or a create nested under a ticket; the suites would report false errors. A test fails if a ticket route is neither declared nor listed |
| `GET /v1/tickets/:id/comments` declared as a second read action of `tickets` | Leave it out | It has the same visibility as reading the ticket, so isolation suites can check it |

No new dependencies (the app has the template's pinned set).

## 4. Tests executed

From `C:\Users\Bg\Lathe`: `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
`pnpm test:integration` (with `POSTGRES_DB=lathe_p701_test`; Support Desk created its own database
`lathe_p701_test_support_desk`). In `apps/support-desk`: `pnpm test:e2e`. Mutation runs: 7 planted
bugs in `tickets.ts` against the integration tests, 1 against the e2e test.

## 5. Test results

- `format:check`, `typecheck`: exit 0. `lint`: exit 0, "no dependency violations found
  (237 modules, 641 dependencies cruised)".
- `pnpm test`: 25 files, 362 tests passed, exit 0.
- `pnpm test:integration`: foundation 132, template 15, Support Desk 19 passed, exit 0.
- `pnpm test:e2e`: 3 passed (redirect without session; requester opens a ticket, agent adds an
  internal note and sets pending, requester sees the status but not the note; org B sees org A's
  ticket neither in the list nor by URL). The first run had 1 failure in my own test (it read the
  URL before the click had navigated); fixed with a URL wait.
- Mutations, integration (each must fail): requesters see every ticket (2 failed), internal notes
  shown to requesters (1), assign to non-staff (1), requester may triage (1), replies on closed
  tickets (1), requester may write internal notes (1). **Survivor:** org filter dropped from the
  assignee lookup, because RLS still hides other orgs' memberships (intended second layer).
- Mutation, e2e: internal notes shown to requesters: 1 failed, 2 passed (caught).
- The first mutation round showed "19 skipped" for three mutations: the template's fixed client
  addresses hit the sign-in rate limit (429) after many runs. Fixed in both the template and the
  app (random address per sign-in); the three mutations were re-run and caught.

## 6. Remaining issues

- "Harness passes": **not run**. Same conflicts as P1-07 (#23, #24, #26): `route(action)` exports
  and the Better Auth route versus the #24 scan; per-request `requestId` in error bodies versus #23's
  body comparison; strict query schemas (400) versus #23's `?org_id=` list probe; `{ label }` versus
  the contract's `sample`.
- C1 v1 cannot describe nested creates or bodies with ids, so comments and assignment are covered by
  the app's tests only (documented in the contract). Needs a C1 change (architect).
- Requester visibility is enforced in application code, not by RLS (section 3).
- UI is minimal (list, detail, reply, staff controls); the full UI is P6-05. SLA is P6-02.
- e2e is not in CI.

## 7. Dependencies or blockers

Depends on P1-07 (and through it on #18). Merge order: #18, P1-07, then this.

## 8. Recommended next task

P6-02 (SLA on tickets, injected clock) and P7-02 (Team Operations) in parallel.
