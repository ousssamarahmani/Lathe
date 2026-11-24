import {
  defineAction,
  type Action,
  type ActionDeps,
  type ActionResult,
  type Authz,
} from '@lathe/application-foundation';
import type { z } from 'zod';

/** What a handler may rely on. Derived from the session and membership, never from input. */
export interface RouteContext {
  readonly orgId: string;
  readonly userId: string;
  readonly role: string;
  /** The tenant transaction of the foundation executor. Opaque to the API layer. */
  readonly tx: unknown;
}

export interface RouteDefinition<S extends z.ZodType, T> {
  /** Unique route name, the key of `ROUTES`. */
  readonly name: string;
  readonly permission: string;
  readonly resourceType: string;
  readonly input: S;
  readonly handler: (ctx: RouteContext, input: z.output<S>) => Promise<T>;
}

export interface ExecutorRequest {
  readonly headers: Headers;
  readonly input: unknown;
  readonly requestId: string;
}

/**
 * Runs one route as authenticate, membership, permission, tenant transaction,
 * handler, audit. The production implementation is `createFoundationExecutor`
 * (the foundation's `defineAction`). Tests use `TestExecutor`.
 */
export interface Executor {
  /** Called once per route at startup. Throws if the permission is not declared. */
  register<S extends z.ZodType, T>(
    definition: RouteDefinition<S, T>,
  ): (request: ExecutorRequest) => Promise<ActionResult<T>>;
}

export function createFoundationExecutor(deps: ActionDeps, authz: Authz): Executor {
  return {
    register<S extends z.ZodType, T>(definition: RouteDefinition<S, T>) {
      const action: Action<T> = defineAction(authz, {
        permission: definition.permission,
        action: definition.name,
        resourceType: definition.resourceType,
        input: definition.input,
        handler: (ctx, input) =>
          definition.handler(
            {
              orgId: ctx.orgId,
              userId: ctx.principal.userId,
              role: ctx.membership.role,
              tx: ctx.tx,
            },
            input,
          ),
      });
      return (request) => action(deps, request);
    },
  };
}
