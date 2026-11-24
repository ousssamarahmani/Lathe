/**
 * Shared primitives for contracts C1 to C4.
 *
 * Owner: architect. Types and Zod schemas only, no runtime logic (see
 * `.kiro/steering/architecture.md`). Changes go through a handoff request.
 */
import { z } from 'zod';

/** Version of the contract set. A breaking change bumps the major version. */
export const CONTRACT_VERSION = '1.2.0' as const;

/** ISO 8601 timestamp with an explicit offset, for example `2026-11-17T10:00:00Z`. */
export const IsoDateTime = z.iso.datetime({ offset: true });

/** Lowercase hex SHA-256 digest. */
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'expected a lowercase hex sha256');

/** Full 40-character git commit id. Short ids are rejected so results bind to one commit. */
export const GitSha = z.string().regex(/^[a-f0-9]{40}$/, 'expected a full 40-character git sha');

/** Lowercase identifier used for apps and projects, for example `support-desk`. */
export const Slug = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, 'expected a lowercase slug');

/** SQL identifier as used by tenant tables, for example `tickets`. */
export const SqlIdentifier = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/, 'expected a lowercase SQL identifier');

/**
 * Path relative to the repository root, using forward slashes.
 * Rejects absolute paths, drive letters, backslashes, `.` and `..` segments, so a
 * path in a contract can never point outside the repository.
 */
export const RepoRelativePath = z
  .string()
  .min(1)
  .max(500)
  .refine((p) => !p.startsWith('/'), 'path must be relative to the repository root')
  .refine((p) => !p.includes('\\'), 'use forward slashes')
  .refine((p) => !/^[A-Za-z]:/.test(p), 'drive letters are not allowed')
  .refine(
    (p) => p.split('/').every((s) => s !== '' && s !== '.' && s !== '..'),
    'empty, "." and ".." segments are not allowed',
  );

export const OrgId = z.uuid().brand<'OrgId'>();
export type OrgId = z.infer<typeof OrgId>;
export const UserId = z.uuid().brand<'UserId'>();
export type UserId = z.infer<typeof UserId>;
export const ProjectId = z.uuid().brand<'ProjectId'>();
export type ProjectId = z.infer<typeof ProjectId>;
export const SpecId = z.uuid().brand<'SpecId'>();
export type SpecId = z.infer<typeof SpecId>;
export const PlanId = z.uuid().brand<'PlanId'>();
export type PlanId = z.infer<typeof PlanId>;
export const RunId = z.uuid().brand<'RunId'>();
export type RunId = z.infer<typeof RunId>;
export const ApprovalId = z.uuid().brand<'ApprovalId'>();
export type ApprovalId = z.infer<typeof ApprovalId>;
export const MembershipId = z.uuid().brand<'MembershipId'>();
export type MembershipId = z.infer<typeof MembershipId>;
export const RequestId = z.uuid().brand<'RequestId'>();
export type RequestId = z.infer<typeof RequestId>;

/** Kiro session ids come from the Kiro CLI and are not UUIDs. */
export const SessionId = z.string().min(1).max(200).brand<'SessionId'>();
export type SessionId = z.infer<typeof SessionId>;

/** Key of a task inside a plan, for example `T1`. */
export const PlanTaskKey = z.string().regex(/^T[0-9]{1,3}$/, 'expected a plan task key such as T1');
export type PlanTaskKey = z.infer<typeof PlanTaskKey>;

/** The only demo fault Lathe can inject (task P5-05). */
export const FaultName = z.enum(['drop-tenant-filter']);
export type FaultName = z.infer<typeof FaultName>;

/** Label that evidence and UI must show for an injected fault. */
export const FAULT_LABEL = 'injected by Lathe' as const;
