# Support Desk

Multi-tenant help desk built from `templates/app-starter` on `@lathe/application-foundation`
(task P6-01). Requesters open tickets; staff (agents, admins, the owner) triage, assign and reply,
and can leave internal notes the requester never sees.

## Roles

| Role        | Can                                                                                     |
| ----------- | --------------------------------------------------------------------------------------- |
| `requester` | open tickets; see, edit the text of and reply to **their own** tickets                  |
| `agent`     | everything a requester can, on **every** ticket of the org; status, priority, assignee; internal notes; see members |
| `admin`     | everything an agent can, and invite people                                              |
| `owner`     | everything, and change or remove members (an org always keeps one owner)                |

A ticket a member may not see answers 404, exactly like a ticket that does not exist or belongs to
another org. Tickets are closed, never deleted; comments cannot be edited or deleted (the database
refuses both for the app role).

## Run locally

Needs the repository `.env` (names in `.env.example`) and PostgreSQL from `infra/`. The app uses its
own database, `<POSTGRES_DB>_support_desk`.

```sh
pnpm --filter @lathe/support-desk db:create
pnpm --filter @lathe/support-desk migrate
pnpm --filter @lathe/support-desk seed      # orgs a and b, one user per role, password LATHE_TEST_PASSWORD
pnpm --filter @lathe/support-desk dev       # http://localhost:3000
```

Seed users are `<role>@support-desk-org-<a|b>.test`.

## API (all through `defineAction`)

| Route                              | Permission                                     |
| ---------------------------------- | ---------------------------------------------- |
| `GET /v1/tickets`                  | `tickets.list` (`?status=`, `?assignee=me`, cursor) |
| `POST /v1/tickets`                 | `tickets.create` (priority: `tickets.triage`)  |
| `GET /v1/tickets/:id`              | `tickets.read`                                 |
| `PATCH /v1/tickets/:id`            | `tickets.update` (status, priority: `tickets.triage`) |
| `POST /v1/tickets/:id/assign`      | `tickets.assign` (assignee must be staff)      |
| `GET /v1/tickets/:id/comments`     | `comments.list` (internal notes: `comments.internal`) |
| `POST /v1/tickets/:id/comments`    | `comments.create` (internal: `comments.internal`) |

Members, invitations and the org switcher come from the foundation (`/v1/me`, `/v1/members`,
`/v1/invitations`, `/v1/session/active-org`).

## Tests

- `pnpm test` (repository root): unit tests, including the C1 contract check.
- `pnpm --filter @lathe/support-desk test:integration`: HTTP-level tests against PostgreSQL as the
  app role: isolation between orgs, requester visibility, triage, assignment, internal notes,
  members, and the database guarantees.
- `pnpm --filter @lathe/support-desk test:e2e`: Playwright smoke test (browser install:
  `pnpm --filter @lathe/support-desk exec playwright install chromium`).

`src/tenant-contract.ts` is the C1 contract the verification harness uses. The assign and
add-comment routes are listed in `UNDECLARED_ROUTES` with the reason C1 v1 cannot describe them.
