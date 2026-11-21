// Import boundaries (task P0-10). Enforces the dependency table in
// .kiro/steering/architecture.md. Run by `pnpm lint`, so CI runs it on every PR.
// Paths are relative to the repository root. Folders that do not exist yet
// (apps/, services/, integrations/, templates/) are covered in advance; the
// fixtures in scripts/import-boundaries/ prove each rule fires.

/** Top-level packages: <group>/<name>/. */
const PACKAGE = '(packages|apps|services|integrations|templates)/[^/]+';
const TESTS = '([.]test[.]ts$|[.]integration[.]test[.]ts$|/vitest[^/]*[.]config[.]ts$)';

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'No import cycles (architecture.md, dependency rules).',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-unresolvable',
      comment:
        'A first-party import that does not resolve would also escape every rule below. Fix the path.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true, path: '^([.]|@lathe/)' },
    },
    {
      name: 'only-through-index',
      comment:
        'Another package is reached only through its public src/index.ts (the package name), never a deep path.',
      severity: 'error',
      from: { path: `^(${PACKAGE})/` },
      to: {
        path: `^${PACKAGE}/`,
        pathNot: [`^$1/`, `^${PACKAGE}/src/index[.]ts$`],
      },
    },

    // packages/shared-contracts: zod only, no runtime logic.
    {
      name: 'contracts-no-first-party',
      comment: 'shared-contracts imports no other first-party code.',
      severity: 'error',
      from: { path: '^packages/shared-contracts/' },
      to: { path: `^${PACKAGE}/`, pathNot: '^packages/shared-contracts/' },
    },
    {
      name: 'contracts-zod-only',
      comment: 'shared-contracts depends on zod only (tests may use vitest).',
      severity: 'error',
      from: { path: '^packages/shared-contracts/', pathNot: TESTS },
      // Anything that is not a local file: npm packages, Node built-ins, unresolved names.
      to: {
        dependencyTypesNot: ['local', 'localmodule'],
        pathNot: '^zod(/|$)|(^|/)node_modules/zod/',
      },
    },

    // packages/verification-harness: PROTECTED. shared-contracts only.
    {
      name: 'harness-only-contracts',
      comment:
        'The harness imports only shared-contracts, so no agent-writable code can change gate logic.',
      severity: 'error',
      from: { path: '^packages/verification-harness/' },
      to: {
        path: `^${PACKAGE}/`,
        pathNot: '^packages/(verification-harness|shared-contracts)/',
      },
    },
    {
      name: 'nobody-imports-harness',
      comment: 'Nothing imports the harness. The Engine runs `lathe-verify` as a process.',
      severity: 'error',
      from: { pathNot: '^packages/verification-harness/' },
      to: { path: '^packages/verification-harness/' },
    },

    // packages/application-foundation: knows nothing about Lathe.
    {
      name: 'foundation-no-lathe',
      comment: 'application-foundation imports no service, integration, app or template.',
      severity: 'error',
      from: { path: '^packages/application-foundation/' },
      to: { path: '^(services|integrations|apps|templates)/' },
    },

    // apps/support-desk, apps/team-operations (and the template they come from).
    {
      name: 'apps-no-lathe',
      comment: 'Generated apps import no service or integration.',
      severity: 'error',
      from: { path: '^(apps/(support-desk|team-operations)|templates/app-starter)/' },
      to: { path: '^(services|integrations)/' },
    },
    {
      name: 'app-not-other-app',
      comment: 'An app never imports another app (or the template).',
      severity: 'error',
      from: { path: '^(apps/[^/]+|templates/[^/]+)/' },
      to: { path: '^(apps|templates)/', pathNot: '^$1/' },
    },

    // apps/workspace: Engine HTTP API with types from shared-contracts.
    {
      name: 'workspace-only-contracts',
      comment:
        'The Workspace talks to the Engine over HTTP. It imports only shared-contracts first-party code.',
      severity: 'error',
      from: { path: '^apps/workspace/' },
      to: {
        path: `^${PACKAGE}/`,
        pathNot: '^(apps/workspace|packages/shared-contracts)/',
      },
    },
    {
      name: 'workspace-no-db',
      comment: 'The Workspace has no direct database access.',
      severity: 'error',
      from: { path: '^apps/workspace/' },
      to: {
        path: '^(pg|drizzle-orm|better-auth)(/|$)|(^|/)node_modules/(pg|drizzle-orm|better-auth)/',
      },
    },

    // services/factory-engine.
    {
      name: 'engine-no-apps',
      comment: 'The Engine imports no app or template internals.',
      severity: 'error',
      from: { path: '^services/factory-engine/' },
      to: { path: '^(apps|templates)/' },
    },
    {
      name: 'engine-integrations-only-in-main',
      comment:
        'Integrations are wired in only by the composition root, services/factory-engine/src/main.ts.',
      severity: 'error',
      from: {
        path: '^services/factory-engine/',
        pathNot: '^services/factory-engine/src/main[.]ts$',
      },
      to: { path: '^integrations/' },
    },
    {
      name: 'nobody-else-imports-integrations',
      comment:
        'Only the Engine composition root (and an integration itself) imports an integration.',
      severity: 'error',
      from: { path: `^${PACKAGE}/`, pathNot: '^(services/factory-engine|integrations)/' },
      to: { path: '^integrations/' },
    },

    // integrations/kiro, integrations/github: shared-contracts only.
    {
      name: 'integration-only-contracts',
      comment:
        'An integration imports only shared-contracts: no service, no app, no other integration.',
      severity: 'error',
      from: { path: '^(integrations/[^/]+)/' },
      to: {
        path: `^${PACKAGE}/`,
        pathNot: ['^$1/', '^packages/shared-contracts/'],
      },
    },
  ],

  options: {
    doNotFollow: { path: '(^|/)node_modules/' },
    // Only build output is excluded. node_modules must stay visible as import targets
    // (doNotFollow keeps the scan from descending into them).
    exclude: { path: ['(^|/)(dist|coverage|[.]next)/', '^scripts/import-boundaries/fixtures/'] },
    // Type-only imports count: a type import still couples the packages.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
      extensions: ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.json'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
