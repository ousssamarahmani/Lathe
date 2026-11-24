import { ActionError } from '@lathe/application-foundation';
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
import { hashContent } from '../approvals/index.js';
import type { MemoryRunStore } from '../orchestrator/memory-run-store.js';
import type { RouteContext } from './executor.js';
import { paginate } from './pagination.js';
import type { EngineApiStore, NewApproval, PageQuery, PageResult, SpecRecord } from './store.js';
import { toSpec } from './store.js';

export interface MemoryStoreOptions {
  readonly now: () => Date;
  readonly newId: () => string;
  /** Run state and repair count are read from here, as the Postgres store reads the runs table. */
  readonly runStore: MemoryRunStore;
}

interface Owned<T> {
  readonly orgId: string;
  value: T;
}

/** In-memory `EngineApiStore` for unit and contract tests. Same org-scoping contract as the Postgres store. */
export class MemoryApiStore implements EngineApiStore {
  private readonly projects: Owned<Project>[] = [];
  private readonly specs: Owned<SpecRecord>[] = [];
  private readonly plans: Owned<Plan>[] = [];
  private readonly runs: Owned<Run>[] = [];
  private readonly events = new Map<string, RunEvent[]>();
  private readonly deliveryHashes = new Map<string, string>();
  readonly approvals: Array<Approval & { readonly orgId: string }> = [];

  constructor(private readonly options: MemoryStoreOptions) {}

  // --- fixtures for tests -------------------------------------------------
  seedPlan(orgId: string, plan: Plan): void {
    this.plans.push({ orgId, value: plan });
  }
  seedRun(orgId: string, run: Run): void {
    const existing = this.runs.find((r) => r.value.id === run.id);
    if (existing) existing.value = run;
    else this.runs.push({ orgId, value: run });
  }
  seedEvents(runId: string, events: readonly RunEvent[]): void {
    this.events.set(runId, [...events]);
  }
  seedDeliveryHash(runId: string, sha256: string): void {
    this.deliveryHashes.set(runId, sha256);
  }
  setSpecStatus(specId: string, status: Spec['status']): void {
    const spec = this.specs.find((s) => s.value.id === specId);
    if (spec) spec.value = { ...spec.value, status };
  }

  // --- port ---------------------------------------------------------------
  async listProjects(ctx: RouteContext, query: PageQuery): Promise<PageResult<Project>> {
    return paginate(
      this.projects.filter((p) => p.orgId === ctx.orgId).map((p) => p.value),
      query,
    );
  }

  async getProject(ctx: RouteContext, projectId: string): Promise<Project | null> {
    return (
      this.projects.find((p) => p.orgId === ctx.orgId && p.value.id === projectId)?.value ?? null
    );
  }

  async createProject(ctx: RouteContext, request: CreateProjectRequest): Promise<Project> {
    if (this.projects.some((p) => p.orgId === ctx.orgId && p.value.slug === request.slug)) {
      throw new ActionError('conflict', 'a project with this slug exists');
    }
    const project: Project = {
      id: this.options.newId(),
      name: request.name,
      slug: request.slug,
      targetApp: request.targetApp,
      repository: null,
      createdAt: this.options.now().toISOString(),
    } as Project;
    this.projects.push({ orgId: ctx.orgId, value: project });
    return project;
  }

  async listSpecs(
    ctx: RouteContext,
    projectId: string,
    query: PageQuery,
  ): Promise<PageResult<Spec> | null> {
    if (!(await this.getProject(ctx, projectId))) return null;
    const items = this.specs
      .filter((s) => s.orgId === ctx.orgId && s.value.projectId === projectId)
      .map((s) => toSpec(s.value));
    return paginate(items, query);
  }

  async submitSpec(
    ctx: RouteContext,
    projectId: string,
    request: SubmitSpecRequest,
  ): Promise<Spec | null> {
    if (!(await this.getProject(ctx, projectId))) return null;
    let version = 1;
    if (request.supersedes !== undefined) {
      const old = this.specs.find(
        (s) =>
          s.orgId === ctx.orgId &&
          s.value.id === request.supersedes &&
          s.value.projectId === projectId,
      );
      if (!old) return null;
      old.value = { ...old.value, status: 'superseded' };
      version = old.value.version + 1;
    }
    const record: SpecRecord = {
      id: this.options.newId(),
      projectId,
      version,
      title: request.title,
      body: request.body,
      contentSha256: hashContent(request.body),
      status: 'submitted',
      createdAt: this.options.now().toISOString(),
      submittedBy: ctx.userId,
    } as SpecRecord;
    this.specs.push({ orgId: ctx.orgId, value: record });
    return toSpec(record);
  }

  async getSpec(ctx: RouteContext, specId: string): Promise<SpecRecord | null> {
    return this.specs.find((s) => s.orgId === ctx.orgId && s.value.id === specId)?.value ?? null;
  }

  async getPlan(ctx: RouteContext, planId: string): Promise<Plan | null> {
    return this.plans.find((p) => p.orgId === ctx.orgId && p.value.id === planId)?.value ?? null;
  }

  async listRuns(
    ctx: RouteContext,
    projectId: string,
    query: PageQuery,
  ): Promise<PageResult<Run> | null> {
    if (!(await this.getProject(ctx, projectId))) return null;
    const items = this.runs
      .filter((r) => r.orgId === ctx.orgId && r.value.projectId === projectId)
      .map((r) => this.withLiveState(r.value));
    return paginate(items, query);
  }

  async createRun(
    ctx: RouteContext,
    projectId: string,
    request: CreateRunRequest,
  ): Promise<Run | null> {
    if (!(await this.getProject(ctx, projectId))) return null;
    const spec = await this.getSpec(ctx, request.specId);
    if (!spec || spec.projectId !== projectId) return null;
    if (spec.status !== 'approved') {
      throw new ActionError('conflict', 'the spec is not approved');
    }
    const now = this.options.now().toISOString();
    const run: Run = {
      id: this.options.newId(),
      projectId,
      specId: spec.id,
      planId: null,
      state: 'DEFINED',
      demo: request.demo,
      faultInjection: request.faultInjection,
      repairAttempts: 0,
      createdAt: now,
      updatedAt: now,
    } as Run;
    this.runs.push({ orgId: ctx.orgId, value: run });
    return run;
  }

  async getRun(ctx: RouteContext, runId: string): Promise<Run | null> {
    const found = this.runs.find((r) => r.orgId === ctx.orgId && r.value.id === runId);
    return found ? this.withLiveState(found.value) : null;
  }

  async getDeliveryContentHash(ctx: RouteContext, runId: string): Promise<string | null> {
    if (!(await this.getRun(ctx, runId))) return null;
    return this.deliveryHashes.get(runId) ?? null;
  }

  async recordApproval(ctx: RouteContext, approval: NewApproval): Promise<Approval> {
    const record = {
      id: this.options.newId(),
      subjectType: approval.subjectType,
      subjectId: approval.subjectId,
      contentSha256: approval.contentSha256,
      decision: approval.decision,
      approverId: approval.approverId,
      decidedAt: this.options.now().toISOString(),
    } as Approval;
    this.approvals.push({ ...record, orgId: ctx.orgId });
    if (approval.subjectType === 'spec' && approval.decision === 'approved') {
      this.setSpecStatus(approval.subjectId, 'approved');
    }
    if (approval.subjectType === 'plan') {
      const plan = this.plans.find(
        (p) => p.orgId === ctx.orgId && p.value.id === approval.subjectId,
      );
      if (plan) {
        plan.value = {
          ...plan.value,
          status: approval.decision === 'approved' ? 'approved' : 'rejected',
        };
      }
    }
    return record;
  }

  async listRunEvents(
    ctx: RouteContext,
    runId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly RunEvent[]> {
    if (!(await this.getRun(ctx, runId))) return [];
    return (this.events.get(runId) ?? []).filter((e) => e.seq > afterSeq).slice(0, limit);
  }

  private withLiveState(run: Run): Run {
    const live = this.options.runStore.get(run.id);
    return live ? { ...run, state: live.state, repairAttempts: live.repairAttempts } : run;
  }
}
