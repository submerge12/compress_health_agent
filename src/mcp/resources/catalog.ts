/**
 * P1: read-only resource catalog.
 *
 * URIs (plan §七.2). Every read is scoped by the transport-verified principal;
 * a caller can never read another user's state. Results carry per-resource
 * cache hints (ttlMs + cacheScope: private) per the 2026-07-28 spec.
 */
import { and, desc, eq, isNull } from "drizzle-orm";

import * as schema from "../../db/schema.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Repository } from "../../db/repository.js";
import { createDailyStateService } from "../../domain/daily-state.js";
import { CACHE_TTL_MS } from "../server-info.js";
import { McpProtocolError } from "../errors.js";
import type { Principal } from "../auth/principal-resolver.js";

type Db = PostgresJsDatabase<typeof schema>;

export interface ResourceReadResult {
  uri: string;
  contents: Array<{ uri: string; mimeType: string; text: string }>;
  /** 2026-07-28 cache hints surfaced in _meta. */
  _meta?: { "compass.health/ttlMs"?: number; "compass.health/cacheScope"?: string };
}

export const RESOURCE_URIS = [
  "health://profile",
  "health://daily-state/{date}",
  "health://constraints/active/{date}",
  "health://plans/training/active",
  "health://training/sessions/{sessionId}",
  "health://training/cycles/current",
  "health://diet/logs/{date}",
  "health://system/capabilities",
] as const;

export function createResourceCatalog(db: Db, repo: Repository) {
  async function listResources(principal: Principal): Promise<Array<Record<string, unknown>>> {
    void principal; // listing is identity-independent; reads are scoped
    return [
      {
        uri: "health://profile",
        name: "User health profile",
        description: "Bound user's profile: timezone, locale, identity.",
        mimeType: "application/json",
        _meta: cacheHints(CACHE_TTL_MS.profile),
      },
      {
        uri: "health://daily-state/{date}",
        name: "Daily health state",
        description: "Rebuildable projection for one day: training, body, diet, constraints. date=YYYY-MM-DD or 'today'.",
        mimeType: "application/json",
        _meta: cacheHints(CACHE_TTL_MS.dailyState),
      },
      {
        uri: "health://constraints/active/{date}",
        name: "Active constraints",
        description: "Un-lifted pain/activity constraints effective on a date. Read BEFORE any training advice.",
        mimeType: "application/json",
        _meta: cacheHints(CACHE_TTL_MS.activeConstraints),
      },
      {
        uri: "health://plans/training/active",
        name: "Active training plan version",
        description: "The active plan_versions row with compiled content_json.",
        mimeType: "application/json",
        _meta: cacheHints(CACHE_TTL_MS.activePlan),
      },
      {
        uri: "health://training/sessions/{sessionId}",
        name: "Training session",
        description: "One session with exercises and logged sets.",
        mimeType: "application/json",
        _meta: cacheHints(CACHE_TTL_MS.inProgressSession),
      },
      {
        uri: "health://training/cycles/current",
        name: "Current cycle position",
        description: "Explicit cycle instance/positions and the engine's advisory next-day decision.",
        mimeType: "application/json",
        _meta: cacheHints(CACHE_TTL_MS.dailyState),
      },
      {
        uri: "health://diet/logs/{date}",
        description: "Effective (non-superseded) diet logs for a date.",
        name: "Diet logs",
        mimeType: "application/json",
        _meta: cacheHints(CACHE_TTL_MS.dailyState),
      },
      {
        uri: "health://system/capabilities",
        name: "System capabilities",
        description: "Server identity, protocol versions, handle model.",
        mimeType: "application/json",
        _meta: cacheHints(CACHE_TTL_MS.systemCapabilities),
      },
    ].sort((a, b) => String(a.uri).localeCompare(String(b.uri))); // deterministic order
  }

  async function readResource(principal: Principal, uri: string): Promise<ResourceReadResult> {
    const hints = cacheHintsForUri(uri);
    const text = JSON.stringify(await readBody(principal, uri), null, 2);
    return {
      uri,
      contents: [{ uri, mimeType: "application/json", text }],
      ...(hints ? { _meta: hints } : {}),
    };
  }

  async function readBody(principal: Principal, uri: string): Promise<unknown> {
    const today = new Date().toISOString().slice(0, 10);
    if (uri === "health://profile") {
      const [user] = await db.select().from(schema.users)
        .where(eq(schema.users.id, principal.userId)).limit(1);
      if (!user) throw new McpProtocolError("not_found", "user vanished");
      return {
        userId: user.id,
        externalUserId: user.externalId,
        locale: user.locale,
        timezone: user.timezone,
        actor: principal.actor,
      };
    }
    if (uri.startsWith("health://daily-state/")) {
      const date = normalizeDate(uri.slice("health://daily-state/".length), today);
      const state = await createDailyStateService(db, repo)
        .buildDailyState(principal.userId, date, "Asia/Shanghai");
      return state;
    }
    if (uri.startsWith("health://constraints/active/")) {
      const date = normalizeDate(uri.slice("health://constraints/active/".length), today);
      return db.select().from(schema.healthConstraints).where(and(
        eq(schema.healthConstraints.userId, principal.userId),
        isNull(schema.healthConstraints.liftedAt),
      ));
    }
    if (uri === "health://plans/training/active") {
      const [assignment] = await db.select().from(schema.activePlanAssignments)
        .where(and(
          eq(schema.activePlanAssignments.userId, principal.userId),
          eq(schema.activePlanAssignments.scope, "training_template"),
        )).limit(1);
      if (!assignment) return { active: false };
      const [version] = await db.select().from(schema.planVersions)
        .where(eq(schema.planVersions.id, assignment.planVersionId)).limit(1);
      return { active: true, assignment, version: version ?? null };
    }
    if (uri.startsWith("health://training/sessions/")) {
      const sessionId = uri.slice("health://training/sessions/".length);
      const [session] = await db.select().from(schema.trainingSessions)
        .where(and(
          eq(schema.trainingSessions.id, sessionId),
          eq(schema.trainingSessions.userId, principal.userId), // ownership: 404, never leak
        )).limit(1);
      if (!session) throw new McpProtocolError("not_found", "session not found for this user");
      const exercises = await db.select().from(schema.trainingSessionExercises)
        .where(eq(schema.trainingSessionExercises.sessionId, sessionId));
      return { session, exercises };
    }
    if (uri === "health://training/cycles/current") {
      const { createCycleEngine } = await import("../../training/cycle-engine.js");
      const engine = createCycleEngine(db);
      const decision = await engine.decide(principal.userId, today);
      const positions = await engine.listPositions(principal.userId);
      return { decision, positions };
    }
    if (uri.startsWith("health://diet/logs/")) {
      const date = normalizeDate(uri.slice("health://diet/logs/".length), today);
      return db.select().from(schema.dietLogs).where(and(
        eq(schema.dietLogs.userId, principal.userId),
        eq(schema.dietLogs.logDate, date),
        isNull(schema.dietLogs.supersededById),
      ));
    }
    if (uri === "health://system/capabilities") {
      const { serverCapabilitiesDocument } = await import("../server-info.js");
      return serverCapabilitiesDocument();
    }
    throw new McpProtocolError("not_found", `unknown resource uri: ${uri}`);
  }

  return { listResources, readResource };
}

function cacheHints(ttlMs: number) {
  return { "compass.health/ttlMs": ttlMs, "compass.health/cacheScope": "private" };
}

function cacheHintsForUri(uri: string): Record<string, unknown> | undefined {
  if (uri === "health://profile") return cacheHints(CACHE_TTL_MS.profile);
  if (uri.startsWith("health://daily-state/")) return cacheHints(CACHE_TTL_MS.dailyState);
  if (uri.startsWith("health://constraints/active/")) return cacheHints(CACHE_TTL_MS.activeConstraints);
  if (uri === "health://plans/training/active") return cacheHints(CACHE_TTL_MS.activePlan);
  if (uri.startsWith("health://training/sessions/")) return cacheHints(CACHE_TTL_MS.inProgressSession);
  if (uri === "health://training/cycles/current") return cacheHints(CACHE_TTL_MS.dailyState);
  if (uri.startsWith("health://diet/logs/")) return cacheHints(CACHE_TTL_MS.dailyState);
  if (uri === "health://system/capabilities") return cacheHints(CACHE_TTL_MS.systemCapabilities);
  return undefined;
}

function normalizeDate(raw: string, today: string): string {
  const value = decodeURIComponent(raw).trim().toLowerCase();
  if (value === "" || value === "today") return today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new McpProtocolError("validation_failed", `bad date in uri: ${raw}`);
  }
  return value;
}
