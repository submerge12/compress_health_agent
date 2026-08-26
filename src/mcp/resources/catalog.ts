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
import { createProjectionWorker } from "../../domain/projection-worker.js";
import { createUserLocalDateResolver } from "../../domain/timezone.js";
import { createTrainingService } from "../../training/training-service.js";
import { CACHE_TTL_MS } from "../server-info.js";
import { McpProtocolError } from "../errors.js";
import type { Principal } from "../auth/principal-resolver.js";

type Db = PostgresJsDatabase<typeof schema>;

export interface ResourceReadResult {
  uri: string;
  contents: Array<{ uri: string; mimeType: string; text: string }>;
  evidence: {
    aggregateType: string;
    aggregateId: string;
    stateRevision?: number;
    resultSummary: Record<string, unknown>;
  };
  /** 2026-07-28 cache hints surfaced in _meta. */
  _meta?: { "compass.health/ttlMs"?: number; "compass.health/cacheScope"?: string };
}

export const RESOURCE_URIS = [
  "health://profile",
  "health://daily-state/today",
  "health://constraints/active/today",
  "health://plans/training/active",
  "health://training/cycles/current",
  "health://diet/logs/today",
  "health://system/capabilities",
] as const;

export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: "health://daily-state/{date}",
    name: "Daily health state by date",
    description: "DailyHealthState V2 for one day: plans, actuals, deviations, training, body, decisions, and projection diagnostics.",
    mimeType: "application/json",
    _meta: cacheHints(CACHE_TTL_MS.dailyState),
  },
  {
    uriTemplate: "health://constraints/active/{date}",
    name: "Active constraints by date",
    description: "Un-lifted pain/activity constraints effective on a date. Read BEFORE any training advice.",
    mimeType: "application/json",
    _meta: cacheHints(CACHE_TTL_MS.activeConstraints),
  },
  {
    uriTemplate: "health://training/sessions/{sessionId}",
    name: "Training session by id",
    description: "One session with exercises and logged sets.",
    mimeType: "application/json",
    _meta: cacheHints(CACHE_TTL_MS.inProgressSession),
  },
  {
    uriTemplate: "health://diet/logs/{date}",
    name: "Diet logs by date",
    description: "Effective (non-superseded) diet logs for a date.",
    mimeType: "application/json",
    _meta: cacheHints(CACHE_TTL_MS.dailyState),
  },
] as const;

export function createResourceCatalog(
  db: Db,
  repo: Repository,
  options: { now?: () => Date } = {},
) {
  const dailyState = createDailyStateService(db, repo);
  const projectionWorker = createProjectionWorker(db, repo);
  const training = createTrainingService(db);
  const getUserLocalDate = createUserLocalDateResolver(db, options.now);
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
        uri: "health://daily-state/today",
        name: "Daily health state",
        description: "Today's rebuildable daily health-state projection.",
        mimeType: "application/json",
        _meta: cacheHints(CACHE_TTL_MS.dailyState),
      },
      {
        uri: "health://constraints/active/today",
        name: "Active constraints",
        description: "Today's un-lifted pain/activity constraints. Read BEFORE any training advice.",
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
        uri: "health://training/cycles/current",
        name: "Current cycle position",
        description: "Explicit cycle instance/positions and the engine's advisory next-day decision.",
        mimeType: "application/json",
        _meta: cacheHints(CACHE_TTL_MS.dailyState),
      },
      {
        uri: "health://diet/logs/today",
        description: "Today's effective (non-superseded) diet logs.",
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

  async function listResourceTemplates(
    principal: Principal,
  ): Promise<Array<Record<string, unknown>>> {
    void principal;
    return [...RESOURCE_TEMPLATES]
      .sort((a, b) => a.uriTemplate.localeCompare(b.uriTemplate));
  }

  async function readResource(principal: Principal, uri: string): Promise<ResourceReadResult> {
    const hints = cacheHintsForUri(uri);
    const today = await getUserLocalDate(principal.userId);
    const body = await readBody(principal, uri, today);
    const text = JSON.stringify(body, null, 2);
    return {
      uri,
      contents: [{ uri, mimeType: "application/json", text }],
      evidence: summarizeResourceRead(principal, uri, body, today),
      ...(hints ? { _meta: hints } : {}),
    };
  }

  async function readBody(principal: Principal, uri: string, today: string): Promise<unknown> {
    if (uri === "health://profile") {
      const [[user], bodyProfile] = await Promise.all([
        db.select().from(schema.users)
          .where(eq(schema.users.id, principal.userId)).limit(1),
        repo.getEffectiveBmrProfile(principal.userId, today),
      ]);
      if (!user) throw new McpProtocolError("not_found", "user vanished");
      return {
        userId: user.id,
        externalUserId: user.externalId,
        locale: user.locale,
        timezone: user.timezone,
        actor: principal.actor,
        bodyProfile: bodyProfile ?? null,
      };
    }
    if (uri.startsWith("health://daily-state/")) {
      const date = normalizeDate(uri.slice("health://daily-state/".length), today);
      const [state, diagnostics] = await Promise.all([
        dailyState.getDailyProjection(principal.userId, date),
        projectionWorker.getDiagnostics(principal.userId, date),
      ]);
      const materialized = state !== undefined;
      const effectiveState = state ?? await (async () => {
        const [user] = await db.select({ timezone: schema.users.timezone })
          .from(schema.users)
          .where(eq(schema.users.id, principal.userId))
          .limit(1);
        if (!user) throw new McpProtocolError("not_found", "user vanished");
        return dailyState.buildDailyState(principal.userId, date, user.timezone);
      })();
      const diagnosticStatus = diagnostics.status === "failed"
        || diagnostics.status === "lagging"
        || diagnostics.status === "rebuilding"
        || diagnostics.status === "fresh"
        ? diagnostics.status
        : effectiveState.projection.status;
      return {
        ...effectiveState,
        projection: {
          ...effectiveState.projection,
          status: diagnosticStatus,
          pendingEvents: diagnostics.outbox.pending + diagnostics.outbox.processing,
          deadLetterEvents: diagnostics.outbox.deadLetter,
          materialized,
          checkpoint: diagnostics.checkpoint,
          outbox: diagnostics.outbox,
        },
      };
    }
    if (uri.startsWith("health://constraints/active/")) {
      const date = normalizeDate(uri.slice("health://constraints/active/".length), today);
      return dailyState.listActiveConstraints(principal.userId, date);
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
      return training.readBackSession(principal.userId, sessionId);
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

  return { listResources, listResourceTemplates, readResource };
}

function summarizeResourceRead(
  principal: Principal,
  uri: string,
  body: unknown,
  today: string,
): ResourceReadResult["evidence"] {
  const record = asRecord(body);
  if (uri.startsWith("health://daily-state/")) {
    const localDate = stringValue(record["localDate"]) ?? "unknown";
    const projection = asRecord(record["projection"]);
    const revision = numberValue(record["revision"]);
    return {
      aggregateType: "daily_state_projection",
      aggregateId: `${principal.userId}:${localDate}`,
      ...(revision !== undefined ? { stateRevision: revision } : {}),
      resultSummary: {
        localDate,
        hasState: record["state"] !== null,
        projectionStatus: stringValue(projection["status"]) ?? "unknown",
        ...(revision !== undefined ? { revision } : {}),
      },
    };
  }
  if (uri.startsWith("health://constraints/active/")) {
    const constraints = Array.isArray(body) ? body.map(asRecord) : [];
    const date = resolvedDateTail(uri, "health://constraints/active/", today);
    return {
      aggregateType: "health_constraint_set",
      aggregateId: `${principal.userId}:${date}`,
      resultSummary: {
        date,
        constraintCount: constraints.length,
        constraintIds: constraints
          .map((constraint) => stringValue(constraint["id"]))
          .filter((id): id is string => id !== undefined),
      },
    };
  }
  if (uri === "health://plans/training/active") {
    const version = asRecord(record["version"]);
    return {
      aggregateType: "active_training_plan",
      aggregateId: stringValue(version["id"]) ?? principal.userId,
      resultSummary: {
        active: record["active"] === true,
        planVersionId: stringValue(version["id"]) ?? null,
        versionNumber: numberValue(version["versionNumber"]) ?? null,
      },
    };
  }
  if (uri.startsWith("health://training/sessions/")) {
    const session = asRecord(record["session"]);
    const exercises = Array.isArray(record["exercisesWithSets"])
      ? record["exercisesWithSets"] as unknown[]
      : [];
    return {
      aggregateType: "training_session",
      aggregateId: stringValue(session["id"]) ?? decodedTail(uri, "health://training/sessions/"),
      resultSummary: {
        status: stringValue(session["status"]) ?? "unknown",
        exerciseCount: exercises.length,
        setCount: exercises.reduce((count: number, item: unknown) => {
          const sets = asRecord(item)["sets"];
          return count + (Array.isArray(sets) ? sets.length : 0);
        }, 0),
      },
    };
  }
  if (uri === "health://training/cycles/current") {
    const positions = Array.isArray(record["positions"]) ? record["positions"] : [];
    const decision = asRecord(record["decision"]);
    return {
      aggregateType: "training_cycle",
      aggregateId: principal.userId,
      resultSummary: {
        positionCount: positions.length,
        nextRole: stringValue(decision["decision"]) ?? null,
        reasonCodes: Array.isArray(decision["reasonCodes"])
          ? decision["reasonCodes"]
          : [],
      },
    };
  }
  if (uri.startsWith("health://diet/logs/")) {
    const date = resolvedDateTail(uri, "health://diet/logs/", today);
    return {
      aggregateType: "diet_log_set",
      aggregateId: `${principal.userId}:${date}`,
      resultSummary: { date, logCount: Array.isArray(body) ? body.length : 0 },
    };
  }
  if (uri === "health://profile") {
    return {
      aggregateType: "user_profile",
      aggregateId: principal.userId,
      resultSummary: { found: true },
    };
  }
  return {
    aggregateType: "system_capabilities",
    aggregateId: "compass-health",
    resultSummary: { available: true },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function decodedTail(uri: string, prefix: string): string {
  return decodeURIComponent(uri.slice(prefix.length));
}

function resolvedDateTail(uri: string, prefix: string, today: string): string {
  const value = decodedTail(uri, prefix).trim().toLowerCase();
  return value === "" || value === "today" ? today : value;
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
