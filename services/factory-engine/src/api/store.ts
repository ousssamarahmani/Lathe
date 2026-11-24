import type {
  Approval,
  CreateProjectRequest,
  CreateRunRequest,
  Plan,
  Project,
  Run,
  RunEvent,
  Spec,
  SubmitSpecRequest,
} from '@lathe/shared-contracts';
import type { RouteContext } from './executor.js';

export interface PageQuery {
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface PageResult<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export type SpecRecord = Spec & { readonly submittedBy: string };

export interface NewApproval {
  readonly subjectType: 'spec' | 'plan' | 'delivery';
  readonly subjectId: string;
  readonly contentSha256: string;
  readonly decision: 'approved' | 'rejected';
  readonly approverId: string;
}

/**
 * Persistence port of the API. Every method is scoped to `ctx.orgId` and returns
 * `null` for a missing resource and for a resource of another org alike. Writes
 * run in `ctx.tx` so they commit with the audit event. A Postgres implementation
 * (RLS, non-owner role) is not part of this task.
 */
export interface EngineApiStore {
  listProjects(ctx: RouteContext, query: PageQuery): Promise<PageResult<Project>>;
  getProject(ctx: RouteContext, projectId: string): Promise<Project | null>;
  /** Throws `ActionError('conflict')` for a duplicate slug. */
  createProject(ctx: RouteContext, request: CreateProjectRequest): Promise<Project>;

  listSpecs(
    ctx: RouteContext,
    projectId: string,
    query: PageQuery,
  ): Promise<PageResult<Spec> | null>;
  /** `null`: project (or the superseded spec) not found in this org. */
  submitSpec(
    ctx: RouteContext,
    projectId: string,
    request: SubmitSpecRequest,
  ): Promise<Spec | null>;
  getSpec(ctx: RouteContext, specId: string): Promise<SpecRecord | null>;

  getPlan(ctx: RouteContext, planId: string): Promise<Plan | null>;

  listRuns(ctx: RouteContext, projectId: string, query: PageQuery): Promise<PageResult<Run> | null>;
  /** `null`: project or spec not found in this org. */
  createRun(ctx: RouteContext, projectId: string, request: CreateRunRequest): Promise<Run | null>;
  getRun(ctx: RouteContext, runId: string): Promise<Run | null>;

  /** Hash of the delivery content awaiting approval, or `null` if the run has none. */
  getDeliveryContentHash(ctx: RouteContext, runId: string): Promise<string | null>;

  /** Stores the approval and applies the status change of the subject atomically. */
  recordApproval(ctx: RouteContext, approval: NewApproval): Promise<Approval>;

  /**
   * Events of the run with `seq` greater than `afterSeq` (-1 for all), ascending. `[]` if none.
   * Called after the request transaction ended, so `ctx.tx` is `null`: a Postgres
   * implementation must open its own `withTenant(ctx.orgId, ...)` transaction.
   */
  listRunEvents(
    ctx: RouteContext,
    runId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly RunEvent[]>;
}

/** Drops internal fields (the submitter) before a spec record leaves the API layer. */
export function toSpec(record: SpecRecord): Spec {
  return {
    id: record.id,
    projectId: record.projectId,
    version: record.version,
    title: record.title,
    body: record.body,
    contentSha256: record.contentSha256,
    status: record.status,
    createdAt: record.createdAt,
  };
}
