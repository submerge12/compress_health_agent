/**
 * P1: actor binding and principal resolution.
 *
 * Identity model:
 * - The USER principal comes from the binding configured at server startup
 *   (STDIO local mode) or verified from the bearer token (HTTP mode). It is
 *   NEVER taken from tool arguments — a client cannot impersonate another
 *   user by passing a different externalUserId.
 * - The ACTOR names which verified server-configured runtime is acting
 *   (codex-primary, pi, dsh, reviewer, …). Request metadata cannot override
 *   this identity. Runs and receipts bind the resolved formal Actor Profile.
 */
import { eq } from "drizzle-orm";

import * as schema from "../../db/schema.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  normalizeActorProfile,
  resolveActor,
  type ActorConfiguration,
  type ActorProfileInput,
  type VerifiedActorProfile,
} from "./actor-registry.js";

type Db = PostgresJsDatabase<typeof schema>;
import { McpProtocolError } from "../errors.js";

export interface Principal {
  /** compass_health.users.id (uuid). */
  userId: string;
  /** External identity string, e.g. "compass-health:1". */
  externalUserId: string;
  /** Declared actor label (evidence only, not authorization). */
  actor: string;
  /** Durable formal actor row bound to every run and receipt. */
  actorId: string;
  actorProfile: VerifiedActorProfile;
}

export interface ActorBindingOptions extends ActorConfiguration {
  /**
   * STDIO local mode: the single bound user's external id. Required — the
   * server refuses to start tools without an explicit binding.
   */
  externalUserId?: string;
  /** Actor label recorded on runs/steps (default codex-primary). */
  actor?: string;
  /** Full server-verified runtime/model attribution. */
  actorProfile?: ActorProfileInput;
  /** Internal invariant: startup ToolContext must resolve to this same user. */
  expectedUserId?: string;
}

export function createPrincipalResolver(db: Db, options: ActorBindingOptions) {
  async function resolvePrincipal(_meta: Record<string, unknown> | undefined): Promise<Principal> {
    const binding = options.externalUserId;
    if (!binding) {
      throw new McpProtocolError(
        "missing_external_user_id",
        "server has no user binding configured (set COMPASS_HEALTH_USER_BINDING)",
      );
    }
    const [user] = await db.select().from(schema.users)
      .where(eq(schema.users.externalId, binding))
      .limit(1);
    if (!user) {
      throw new McpProtocolError(
        "unknown_user_binding",
        `unknown user binding: ${binding}; provision it explicitly before starting MCP`,
      );
    }
    assertExpectedUser(user.id, options.expectedUserId);
    const actor = await resolveActor(db, options);
    return {
      userId: user.id,
      externalUserId: binding,
      actor: actor.verifiedActor,
      actorId: actor.id,
      actorProfile: actor,
    };
  }

  return { resolvePrincipal };
}

/** Actor identity comes from server startup configuration, never request metadata. */
export function verifiedActor(options: ActorBindingOptions): string {
  return normalizeActorProfile(options).verifiedActor;
}

function assertExpectedUser(actualUserId: string, expectedUserId: string | undefined): void {
  if (expectedUserId !== undefined && actualUserId !== expectedUserId) {
    throw new McpProtocolError("unauthorized_actor", "principal and ToolContext user mismatch");
  }
}
