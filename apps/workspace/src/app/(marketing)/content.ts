/**
 * Every claim the landing page makes (task P9-01), with the repository artifact
 * that proves it. The page renders only from this file, so no sentence can
 * reach the page without an entry here.
 *
 * Rules (docs/design/landing-claims.md):
 * - `built`: merged on `main` with tests. Evidence is repository paths.
 * - `in-progress`: code exists but is not merged. Evidence may be a pull request.
 * - `planned`: designed, not built. Evidence is the design document.
 * - No pricing, no invented numbers, no "production ready", no deployment claims.
 *
 * `landing.test.tsx` checks that every evidence path exists and that
 * docs/design/landing-claims.md lists every claim id.
 */

export const REPO_URL = 'https://github.com/Lathedottech/Lathe';

export type ClaimStatus = 'built' | 'in-progress' | 'planned';

export interface Claim {
  /** Stable id, listed in docs/design/landing-claims.md. */
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly status: ClaimStatus;
  /** Repository paths (relative to the root) or, for `in-progress`, a pull request URL. */
  readonly evidence: readonly string[];
}

export const STATUS_LABEL: Readonly<Record<ClaimStatus, string>> = {
  built: 'Built and tested',
  'in-progress': 'In review',
  planned: 'Planned',
};

/** Repository link for a path, for the "Evidence" links under each claim. */
export function evidenceUrl(evidence: string): string {
  if (evidence.startsWith('https://')) return evidence;
  const isDir = !/\.[a-z0-9]+$/i.test(evidence);
  return `${REPO_URL}/${isDir ? 'tree' : 'blob'}/main/${evidence}`;
}

export const HERO = {
  title: 'Your Mini Software Factory',
  lead: 'An agent writes the code. Lathe verifies it with deterministic gates the agent cannot edit, and a human approves what ships.',
  notice:
    'Pre-alpha, built for Kiroween 2026. Each part below says whether it is built, in review or planned.',
} as const;

/** The loop, as designed. `planned` until the Factory Engine runs it (task P5-07). */
export const WORKFLOW = {
  id: 'workflow-loop',
  status: 'planned' as ClaimStatus,
  evidence: [
    'docs/architecture/05-verification-repair-loop.md',
    'docs/adr/0002-kiro-integration-via-acp.md',
  ],
  intro:
    'The loop the Factory Engine is designed to run. Steps marked Planned are not running yet.',
  steps: [
    { name: 'Define', text: 'A human writes the specification.' },
    { name: 'Plan', text: 'A planner agent drafts a task plan. A human approves it.' },
    { name: 'Build', text: 'A builder agent changes code inside an isolated container.' },
    { name: 'Test', text: 'Deterministic gates run on the change.' },
    {
      name: 'Verify',
      text: 'A fresh container re-runs every gate on a clean tree. Only the Engine records a pass.',
    },
    {
      name: 'Ship',
      text: 'Lathe opens a draft pull request with evidence. A human reviews and merges it.',
    },
  ],
} as const;

export const CAPABILITIES: readonly Claim[] = [
  {
    id: 'tenant-isolation',
    title: 'Tenant isolation in the database',
    text: 'Every tenant table uses PostgreSQL row-level security, forced, through a role that cannot bypass it. A request in one organization reads zero rows of another.',
    status: 'built',
    evidence: [
      'packages/application-foundation/migrations/0002_tenancy_rls.sql',
      'packages/application-foundation/src/tenancy/tenancy.integration.test.ts',
      'docs/reports/P1-02-backend.md',
    ],
  },
  {
    id: 'deny-by-default',
    title: 'Deny by default',
    text: 'Every action declares the permission it needs. Unknown roles and missing permissions are refused, denials are audited, and an action without a permission does not compile.',
    status: 'built',
    evidence: [
      'packages/application-foundation/src/authz/action.ts',
      'packages/application-foundation/src/authz/policy.test.ts',
      'packages/application-foundation/src/authz/authz.integration.test.ts',
      'docs/reports/P1-05-backend.md',
    ],
  },
  {
    id: 'auth-and-orgs',
    title: 'Sign-in, organizations and invitations',
    text: 'Email and password sign-in with server-side sessions and rate limits. Organizations, single-use invitation links, roles, and an owner that cannot be removed while last.',
    status: 'built',
    evidence: [
      'packages/application-foundation/src/auth/auth.integration.test.ts',
      'packages/application-foundation/src/orgs/orgs.integration.test.ts',
      'docs/reports/P1-03-backend.md',
    ],
  },
  {
    id: 'audit-log',
    title: 'Append-only audit log',
    text: 'Changes and denials write an audit event in the same transaction. The application role cannot update or delete audit rows.',
    status: 'built',
    evidence: [
      'packages/application-foundation/src/audit/audit.ts',
      'packages/application-foundation/src/db/schema.integration.test.ts',
    ],
  },
  {
    id: 'verification-harness',
    title: 'Verification harness',
    text: 'A gate runner whose result is bound to a hash of the commit, the harness and the policy, and a first gate that rejects changes to protected paths such as CI and the harness itself.',
    status: 'in-progress',
    evidence: [`${REPO_URL}/pull/5`],
  },
  {
    id: 'kiro-sandbox',
    title: 'Kiro in a hardened container',
    text: 'Kiro runs over the Agent Client Protocol inside a container with no root user, no added capabilities and a read-only file system. A spike wrote a file and cancelled a prompt this way.',
    status: 'built',
    evidence: [
      'docs/spikes/kiro-acp.md',
      'scripts/spikes/kiro-sandbox/docker-run-args.json',
      'docs/adr/0003-kiro-authentication-for-automation.md',
    ],
  },
];

export const ARCHITECTURE: readonly Claim[] = [
  {
    id: 'arch-foundation',
    title: 'Application foundation',
    text: 'Reusable sign-in, organizations, permissions, tenant isolation and audit, shared by every app.',
    status: 'built',
    evidence: ['packages/application-foundation/src/index.ts'],
  },
  {
    id: 'arch-contracts',
    title: 'Shared contracts',
    text: 'Typed interfaces between the Engine, the Kiro adapter, the gates and the Workspace.',
    status: 'built',
    evidence: ['packages/shared-contracts/src/api.ts'],
  },
  {
    id: 'arch-harness',
    title: 'Verification harness',
    text: 'Deterministic gates that agents cannot change.',
    status: 'in-progress',
    evidence: [`${REPO_URL}/pull/5`],
  },
  {
    id: 'arch-engine',
    title: 'Factory Engine',
    text: 'Runs the loop: state machine, sandboxes, evidence and approvals.',
    status: 'planned',
    evidence: ['docs/architecture/02-factory-engine.md'],
  },
  {
    id: 'arch-delivery',
    title: 'GitHub delivery',
    text: 'Opens draft pull requests with evidence. It has no merge call.',
    status: 'planned',
    evidence: ['docs/architecture/06-github-delivery.md'],
  },
  {
    id: 'arch-workspace',
    title: 'Workspace',
    text: 'The operator interface for projects, runs, gates and approvals.',
    status: 'in-progress',
    evidence: ['docs/design/design-system.md', 'docs/design/wireframes.md'],
  },
];

export const KIRO: readonly Claim[] = [
  {
    id: 'kiro-dev-time',
    title: 'Built with Kiro',
    text: 'Lathe itself is built by Kiro agents, each limited to the folders it owns, guided by steering files and specifications in the repository.',
    status: 'built',
    evidence: ['.kiro/agents', '.kiro/steering', '.kiro/specs', 'docs/kiro-usage.md'],
  },
  {
    id: 'kiro-runtime',
    title: 'Kiro inside Lathe',
    text: 'At runtime, Lathe drives Kiro CLI through the Agent Client Protocol, with no MCP servers and no credentials other than the Kiro session.',
    status: 'in-progress',
    evidence: ['docs/adr/0002-kiro-integration-via-acp.md', 'docs/spikes/kiro-acp.md'],
  },
];

export const NAV = [
  { href: '#product', label: 'Product' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#architecture', label: 'Architecture' },
  { href: REPO_URL, label: 'GitHub' },
] as const;

export const GET_STARTED_URL = `${REPO_URL}#quickstart`;

export const FOOTER_LINKS = [
  { href: REPO_URL, label: 'GitHub' },
  { href: `${REPO_URL}/blob/main/README.md`, label: 'Documentation' },
  { href: `${REPO_URL}/blob/main/ARCHITECTURE.md`, label: 'Architecture' },
  { href: `${REPO_URL}/blob/main/SECURITY.md`, label: 'Security' },
  { href: `${REPO_URL}/blob/main/LICENSE`, label: 'MIT License' },
] as const;

/** Every claim on the page, for the claims test. */
export const ALL_CLAIMS: readonly Pick<Claim, 'id' | 'status' | 'evidence'>[] = [
  WORKFLOW,
  ...CAPABILITIES,
  ...ARCHITECTURE,
  ...KIRO,
];
