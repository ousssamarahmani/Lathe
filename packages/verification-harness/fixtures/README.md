# Fixtures

Planted defects each gate must catch. A gate is only done when its fixtures fail.

- Runner (P2-01): planted gates that fail, fail without findings, throw, or register under the wrong id live in `src/runner.test.ts`. The default registry is tested to never pass (`src/cli.test.ts`).
- Gate fixtures arrive with their gates: protected paths (P2-02), static and tests (P2-03), tenant isolation (P2-04), RBAC (P2-05), properties (P2-06), security (P2-07).
