/**
 * P1: actor binding and principal resolution.
 *
 * Identity model:
 * - The USER principal comes from the binding configured at server startup
 *   (STDIO local mode) or verified from the bearer token (HTTP mode). It is
 *   NEVER taken from tool arguments — a client cannot impersonate another
 *   user by passing a different externalUserId.
 * - The ACTOR names which agent runtime is acting (codex-primary, pi, dsh,
 *   reviewer, …). Clients may declare an actor via the X-Compass-Actor-style
 *   field in _meta, but the server records it verbatim for evidence only;
 *   authorization derives from the transport-verified principal, not the
 *   declared actor string.
 */
import { eq } from "drizzle-orm";

import * as schema from "../../db/schema.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

type Db = PostgresJsDatabase<typeof schema>;
import { McpProtocolError } from "../errors.js";

export interface Principal {
  /** compass_health.users.id (uuid). */
  userId: string;
  /** External identity string, e.g. "compass-health:1". */
  externalUserId: string;
  /** Declared actor label (evidence only, not authorization). */
  actor: string;
}

export interface ActorBindingOptions {
  /**
   * STDIO local mode: the single bound user's external id. Required — the
   * server refuses to start tools without an explicit binding.
   */
  externalUserId?: string;
  /** Actor label recorded on runs/steps (default codex-primary). */
  actor?: string;
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
    return { userId: user.id, externalUserId: binding, actor: verifiedActor(options) };
  }

  return { resolvePrincipal };
}

/** Actor identity comes from server startup configuration, never request metadata. */
function verifiedActor(options: ActorBindingOptions): string {
  const actor = options.actor?.trim();
  return actor ? actor : "codex-primary";
}

function assertExpectedUser(actualUserId: string, expectedUserId: string | undefined): void {
  if (expectedUserId !== undefined && actualUserId !== expectedUserId) {
    throw new McpProtocolError("unauthorized_actor", "principal and ToolContext user mismatch");
  }
}
