# Planner output

Reply with one JSON object and nothing else. You have no write or shell tools.

```
{ "tasks": [ { "key": "t1", "title": "...", "paths": ["apps/<app>/src/..."], "acceptanceChecks": ["..."], "dependsOn": [] } ] }
```

This is the PlanDraft shape (`PlanTask` in `packages/shared-contracts/src/api.ts`): 1 to 50 tasks, `title` up to 200 characters, `paths` repo-relative and never under `packages/verification-harness/` or `.github/`, at least one acceptance check per task, `dependsOn` lists task keys. The Engine validates the schema and a human approves the plan.
