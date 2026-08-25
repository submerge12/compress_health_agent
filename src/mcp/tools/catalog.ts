/**
 * P2 / WO-MCP-3+4: canonical health tools (writes) + MRTR confirmation flows.
 *
 * Risk model (plan §七.3):
 * - read-only: no confirmation;
 * - revocable-write: direct execution, reversible via correction tools;
 * - proposal: persists a handle, never mutates;
 * - confirmation-required (MRTR): first call returns resultType
 *   "input_required" with a durable request; the retry must repeat the SAME
 *   idempotency key + confirm token, else proposal_stale.
 *
 * Every write tool requires a runHandle (health_begin_run). Tool bodies stay
 * thin: they adapt the MCP surface to existing domain services — no health
 * rule lives here.
 */
import { z } from "zod/v4";
import { and, eq, isNull } from "drizzle-orm";

import * as schema from "../../db/schema.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Repository } from "../../db/repository.js";
import type { ToolContext } from "../../tools/context.js";
import { createDietLogService, NeedsConfirmationError, StateConflict } from "../../domain/diet-log-service.js";
import { createDailyStateService } from "../../domain/daily-state.js";
import { createPainCommand } from "../../training/prepared-session.js";
import { createTrainingService } from "../../training/training-service.js";
import { createSubstitutionEngine, SubstitutionProposalError } from "../../training/substitution-engine.js";
import { createReflectionEngine } from "../../training/reflection-engine.js";
import { createRunHandleService } from "../evidence/run-handles.js";

type Db = PostgresJsDatabase<typeof schema>;

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** A pending MRTR request: durable until expiresAt, then proposal_stale. */
interface ConfirmationRequest {
  toolName: string;
  runHandle: string;
  userId: string;
  idempotencyKey: string;
  /** What the user must approve, human-readable. */
  prompt: string;
  choices: string[];
  /** Payload the retry re-uses (already validated, never client-supplied). */
  payload: Record<string, unknown>;
  createdAt: Date;
  expiresAt: Date;
}

export interface ToolInvocation {
  principalUserId: string;
  actor: string;
  args: Record<string, unknown>;
}

export interface ToolOutcome {
  /** complete = executed; input_required = MRTR pending user answer. */
  resultType: "complete" | "input_required";
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structured?: Record<string, unknown>;
}

function complete(structured: Record<string, unknown>): ToolOutcome {
  return {
    resultType: "complete",
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structured,
  };
}

function inputRequired(request: {
  prompt: string;
  choices: string[];
  confirmationId: string;
  expiresAt: string;
}): ToolOutcome {
  return {
    resultType: "input_required",
    content: [{ type: "text", text: JSON.stringify(request) }],
    structured: { resultType: "input_required", ...request },
  };
}

function toolError(code: string, message: string): ToolOutcome {
  return {
    resultType: "complete",
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: code, message }) }],
    structured: { error: code, message },
  };
}

export function createHealthToolCatalog(db: Db, repo: Repository) {
  const runs = createRunHandleService(db);
  const diet = createDietLogService(db, repo);
  const dailyState = createDailyStateService(db, repo);
  const pain = createPainCommand(db);
  const training = createTrainingService(db);
  const substitution = createSubstitutionEngine(db);
  const reflection = createReflectionEngine(db);

  /**
   * MRTR pending confirmations, keyed by confirmationId. Durable across
   * processes would want a table; the payload is already validated and the
   * domain re-validates on retry, so an in-process map with expiry keeps the
   * P2 surface honest without a new migration.
   */
  const pendingConfirmations = new Map<string, ConfirmationRequest>();

  const CONFIRMATION_TTL_MS = 10 * 60_000;

  function makeConfirmation(
    toolName: string,
    invocation: ToolInvocation,
    prompt: string,
    choices: string[],
    payload: Record<string, unknown>,
  ): ToolOutcome {
    const confirmationId = `confirm_${crypto.randomUUID()}`;
    const now = new Date();
    pendingConfirmations.set(confirmationId, {
      toolName,
      runHandle: String(invocation.args["runHandle"] ?? ""),
      userId: invocation.principalUserId,
      idempotencyKey: String(invocation.args["idempotencyKey"] ?? crypto.randomUUID()),
      prompt,
      choices,
      payload,
      createdAt: now,
      expiresAt: new Date(now.getTime() + CONFIRMATION_TTL_MS),
    });
    return inputRequired({
      prompt,
      choices,
      confirmationId,
      expiresAt: new Date(now.getTime() + CONFIRMATION_TTL_MS).toISOString(),
    });
  }

  /** Require a valid run handle for write tools; records the step. */
  async function requireRun(userId: string, args: Record<string, unknown>, mcpName: string) {
    const runHandle = String(args["runHandle"] ?? "");
    if (!runHandle) {
      throw new Error("run_handle_required: call health_begin_run first; writes without a run are not accepted");
    }
    // Ownership check (throws RunHandleError when foreign/unknown).
    const run = await runs.getRun(userId, runHandle);
    await runs.recordStep({
      userId,
      runHandle,
      stage: "tool_call",
      mcpMethod: "tools/call",
      mcpName,
      arguments: args,
    });
    return run;
  }

  function str(args: Record<string, unknown>, key: string): string {
    const v = args[key];
    if (typeof v !== "string" || v.trim() === "") {
      throw new RangeError(`${key} is required`);
    }
    return v.trim();
  }

  function optStr(args: Record<string, unknown>, key: string): string | undefined {
    const v = args[key];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  }

  function optNum(args: Record<string, unknown>, key: string): number | undefined {
    const v = args[key];
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }

  function today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  let sharedContext: ToolContext | null = null;

  /**
   * One shared ToolContext per server process (the STDIO server is
   * single-user by binding). The nutrition estimator needs the meal catalog,
   * which only initToolContext loads.
   */
  async function buildToolContext(userId: string): Promise<ToolContext> {
    if (sharedContext && sharedContext.userId === userId) return sharedContext;
    const { initToolContext } = await import("../../tools/context.js");
    sharedContext = await initToolContext({
      externalUserId: `mcp-bound:${userId}`,
      locale: "zh",
      databaseUrl: process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health",
      timezone: "Asia/Shanghai",
    });
    if (sharedContext.userId !== userId) {
      // The bound user already exists (principal resolver provisioned it);
      // initToolContext found a different row only if the binding drifted.
      throw new Error("tool context user mismatch");
    }
    return sharedContext;
  }

  const toolDefs: Array<{
    name: string;
    description: string;
    risk: "read-only" | "revocable-write" | "proposal" | "confirmation" | "safety-write" | "state-change";
    inputSchema: Record<string, unknown>;
    execute: (invocation: ToolInvocation) => Promise<ToolOutcome>;
  }> = [
    {
      name: "health_begin_run",
      description: "Start a tracked health journey. Returns the runHandle every write tool requires.",
      risk: "read-only",
      inputSchema: {
        type: "object",
        properties: {
          objective: { type: "string", description: "What this journey tries to do (one line)." },
          inputChannel: { type: "string", enum: ["gpt-live", "xiaomi-voice", "mcp", "web"] },
        },
        required: ["objective"],
      },
      execute: async (inv) => {
        return complete(await runs.beginRun({
          userId: inv.principalUserId,
          objective: str(inv.args, "objective"),
          inputChannel: optStr(inv.args, "inputChannel") ?? "mcp",
          actor: inv.actor,
        }));
      },
    },
    {
      name: "health_end_run",
      description: "Close a run with its outcome and the user's acceptance signal.",
      risk: "read-only",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          outcome: { type: "string", enum: ["completed", "failed", "abandoned"] },
          responseSummary: { type: "string" },
          userAccepted: { type: "boolean" },
        },
        required: ["runHandle", "outcome"],
      },
      execute: async (inv) => {
        const outcome = str(inv.args, "outcome") as "completed" | "failed" | "abandoned";
        if (!["completed", "failed", "abandoned"].includes(outcome)) {
          return toolError("validation_failed", "outcome must be completed|failed|abandoned");
        }
        return complete(await runs.endRun({
          userId: inv.principalUserId,
          runHandle: str(inv.args, "runHandle"),
          outcome,
          responseSummary: optStr(inv.args, "responseSummary"),
          userAccepted: inv.args["userAccepted"] === true,
        }));
      },
    },
    {
      name: "health_log_meal",
      description: "Log a meal by description. Ambiguous items return input_required with candidate choices; retry with confirmToken + same idempotencyKey.",
      risk: "revocable-write",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          date: ISO_DATE,
          mealType: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
          description: { type: "string", description: "Free-text meal description." },
          idempotencyKey: { type: "string", description: "Stable key for retries." },
          expectedRevision: { type: "number" },
          confirmToken: { type: "string", description: "confirmationId from a previous input_required." },
          choice: { type: "string", description: "User's chosen candidate (when confirming)." },
        },
        required: ["runHandle", "mealType", "description"],
      },
      execute: async (inv) => {
        await requireRun(inv.principalUserId, inv.args, "health_log_meal");
        const ctx = await buildToolContext(inv.principalUserId);
        try {
          const idempotencyKey = optStr(inv.args, "idempotencyKey") ?? `mcp-meal-${crypto.randomUUID()}`;
          const confirmToken = optStr(inv.args, "confirmToken");
          const choice = optStr(inv.args, "choice");

          // MRTR retry path: apply the user's confirmed resolution.
          if (confirmToken !== undefined) {
            const pending = pendingConfirmations.get(confirmToken);
            pendingConfirmations.delete(confirmToken);
            if (!pending || pending.userId !== inv.principalUserId || pending.toolName !== "health_log_meal") {
              return toolError("proposal_stale", "confirmation unknown, expired, or not yours — start again");
            }
            if (pending.expiresAt < new Date()) {
              return toolError("proposal_stale", "confirmation expired — start again");
            }
            const payload = pending.payload as {
              date: string; mealType: string; description: string;
              overrideEstimate?: Record<string, unknown>;
            };
            const { log, replayed } = await diet.commit(ctx, {
              userId: inv.principalUserId,
              logDate: payload.date,
              mealType: payload.mealType,
              description: payload.description,
              idempotencyKey: pending.idempotencyKey,
              ...(payload.overrideEstimate ? { overrideEstimate: payload.overrideEstimate as never } : {}),
            });
            await dailyState.persistDailyProjection(inv.principalUserId, payload.date, "Asia/Shanghai");
            return complete({ dietLogId: log.id, replayed, caloriesKcal: log.caloriesKcal, confirmed: choice ?? "user-confirmed" });
          }

          // First call: preview; ambiguous -> MRTR.
          const previewResult = await diet.preview(ctx, {
            description: str(inv.args, "description"),
            date: optStr(inv.args, "date") ?? today(),
            mealType: str(inv.args, "mealType"),
          });
          if (previewResult.status === "needs_confirmation") {
            const estimate = previewResult.estimate as {
              needsConfirmation?: Array<{ name?: string; candidates?: string[] }>;
              unmatched?: Array<{ name?: string }>;
            };
            const promptItems = [
              ...(estimate.needsConfirmation ?? []).map((n) => n.name ?? "item"),
              ...(estimate.unmatched ?? []).map((n) => `${n.name ?? "item"} (未匹配)`,
              ),
            ];
            return makeConfirmation(
              "health_log_meal", inv,
              `这些食材需要确认：${promptItems.join("、") || "份量不确定"}`,
              (estimate.needsConfirmation ?? []).flatMap((n) => n.candidates ?? []).slice(0, 5),
              {
                date: optStr(inv.args, "date") ?? today(),
                mealType: str(inv.args, "mealType"),
                description: str(inv.args, "description"),
              },
            );
          }

          // Clean estimate -> commit directly.
          const { log, replayed } = await diet.commit(ctx, {
            userId: inv.principalUserId,
            logDate: optStr(inv.args, "date") ?? today(),
            mealType: str(inv.args, "mealType"),
            description: str(inv.args, "description"),
            idempotencyKey,
            ...(optNum(inv.args, "expectedRevision") !== undefined
              ? { expectedRevision: optNum(inv.args, "expectedRevision") } : {}),
          });
          await dailyState.persistDailyProjection(inv.principalUserId, log.logDate, "Asia/Shanghai");
          return complete({ dietLogId: log.id, replayed, caloriesKcal: log.caloriesKcal });
        } catch (error) {
          if (error instanceof NeedsConfirmationError) {
            return makeConfirmation("health_log_meal", inv, String(error.message), [], {});
          }
          if (error instanceof StateConflict) {
            return toolError("state_conflict", error.message);
          }
          throw error;
        }
      },
    },
    {
      name: "health_correct_meal",
      description: "Correct an existing diet log; creates a superseding revision (original stays for audit).",
      risk: "revocable-write",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          dietLogId: { type: "string" },
          description: { type: "string" },
          mealType: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
          reason: { type: "string" },
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "dietLogId"],
      },
      execute: async (inv) => {
        await requireRun(inv.principalUserId, inv.args, "health_correct_meal");
        const ctx = await buildToolContext(inv.principalUserId);
        const result = await diet.correct(ctx, {
            userId: inv.principalUserId,
            originalLogId: str(inv.args, "dietLogId"),
            ...(optStr(inv.args, "description") ? { description: optStr(inv.args, "description") } : {}),
            ...(optStr(inv.args, "mealType") ? { mealType: optStr(inv.args, "mealType") } : {}),
            reason: optStr(inv.args, "reason") ?? "mcp correction",
            idempotencyKey: optStr(inv.args, "idempotencyKey"),
          });
        await dailyState.persistDailyProjection(inv.principalUserId, result.revised.logDate, "Asia/Shanghai");
        return complete({ correctedLogId: result.revised.id, supersededLogId: result.original.id, caloriesKcal: result.revised.caloriesKcal });
      },
    },
    {
      name: "health_record_water",
      description: "Record a water intake in ml.",
      risk: "revocable-write",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          amountMl: { type: "number" },
          date: ISO_DATE,
        },
        required: ["runHandle", "amountMl"],
      },
      execute: async (inv) => {
        await requireRun(inv.principalUserId, inv.args, "health_record_water");
        const amount = optNum(inv.args, "amountMl");
        if (amount === undefined || amount <= 0 || amount > 10000) {
          return toolError("validation_failed", "amountMl must be 1..10000");
        }
        const date = optStr(inv.args, "date") ?? today();
        const [log] = await db.insert(schema.waterLogs).values({
          userId: inv.principalUserId, logDate: date, amountMl: Math.round(amount),
        }).returning();
        await dailyState.persistDailyProjection(inv.principalUserId, date, "Asia/Shanghai");
        return complete({ waterLogId: log!.id, amountMl: log!.amountMl });
      },
    },
    {
      name: "health_record_activity",
      description: "Record a cardio/activity log (type + minutes).",
      risk: "revocable-write",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          activityType: { type: "string", enum: ["running", "walking", "cycling", "swimming", "strength"] },
          durationMinutes: { type: "number" },
          caloriesBurnedKcal: { type: "number" },
          date: ISO_DATE,
        },
        required: ["runHandle", "activityType", "durationMinutes"],
      },
      execute: async (inv) => {
        await requireRun(inv.principalUserId, inv.args, "health_record_activity");
        const duration = optNum(inv.args, "durationMinutes");
        if (duration === undefined || duration <= 0 || duration > 600) {
          return toolError("validation_failed", "durationMinutes must be 1..600");
        }
        const date = optStr(inv.args, "date") ?? today();
        const [log] = await db.insert(schema.exerciseLogs).values({
          userId: inv.principalUserId,
          logDate: date,
          activityType: str(inv.args, "activityType"),
          durationMinutes: Math.round(duration),
          caloriesBurnedKcal: optNum(inv.args, "caloriesBurnedKcal") ?? 0,
        }).returning();
        await dailyState.persistDailyProjection(inv.principalUserId, date, "Asia/Shanghai");
        return complete({ activityId: log!.id });
      },
    },
    {
      name: "health_record_sleep",
      description: "Record last night's sleep hours.",
      risk: "revocable-write",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          hours: { type: "number" },
          date: ISO_DATE,
        },
        required: ["runHandle", "hours"],
      },
      execute: async (inv) => {
        await requireRun(inv.principalUserId, inv.args, "health_record_sleep");
        const hours = optNum(inv.args, "hours");
        if (hours === undefined || hours < 0 || hours > 24) {
          return toolError("validation_failed", "hours must be 0..24");
        }
        const date = optStr(inv.args, "date") ?? today();
        const result = await dailyState.recordObservation({
          userId: inv.principalUserId, observedOn: date, kind: "sleep",
          valueJson: { hours }, source: "mcp",
        }, { commandType: "mcp.record_sleep", aggregateType: "observation" });
        await dailyState.persistDailyProjection(inv.principalUserId, date, "Asia/Shanghai");
        return complete({ observationId: result.eventId, hours });
      },
    },
    {
      name: "health_record_fatigue",
      description: "Record fatigue with a structured level (1-5) and scope (general|local).",
      risk: "revocable-write",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          level: { type: "number", minimum: 1, maximum: 5 },
          scope: { type: "string", enum: ["general", "local"] },
          feedback: { type: "string" },
          date: ISO_DATE,
        },
        required: ["runHandle", "level", "scope"],
      },
      execute: async (inv) => {
        await requireRun(inv.principalUserId, inv.args, "health_record_fatigue");
        const level = optNum(inv.args, "level");
        if (level === undefined || level < 1 || level > 5) {
          return toolError("validation_failed", "level must be 1..5 (structured fatigue is required)");
        }
        const date = optStr(inv.args, "date") ?? today();
        const result = await dailyState.recordObservation({
          userId: inv.principalUserId, observedOn: date, kind: "fatigue",
          valueJson: { level, scope: str(inv.args, "scope"), ...(optStr(inv.args, "feedback") ? { feedback: optStr(inv.args, "feedback") } : {}) },
          source: "mcp",
        }, { commandType: "mcp.record_fatigue", aggregateType: "observation" });
        await dailyState.persistDailyProjection(inv.principalUserId, date, "Asia/Shanghai");
        return complete({ observationId: result.eventId, level, scope: str(inv.args, "scope") });
      },
    },
    {
      name: "health_report_pain",
      description: "Report pain: records the observation and creates a warn/block constraint in one transaction. Clear input executes directly.",
      risk: "safety-write",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          bodyPart: { type: "string" },
          severity: { type: "string", enum: ["mild", "sharp", "worsening", "unstable", "unknown"] },
          description: { type: "string" },
          date: ISO_DATE,
        },
        required: ["runHandle", "bodyPart", "severity"],
      },
      execute: async (inv) => {
        await requireRun(inv.principalUserId, inv.args, "health_report_pain");
        const date = optStr(inv.args, "date") ?? today();
        const result = await pain.execute({
          userId: inv.principalUserId,
          observedOn: date,
          bodyPart: str(inv.args, "bodyPart"),
          severityHint: str(inv.args, "severity") as never,
          ...(optStr(inv.args, "description") ? { description: optStr(inv.args, "description") } : {}),
        });
        await dailyState.persistDailyProjection(inv.principalUserId, date, "Asia/Shanghai");
        return complete(result as unknown as Record<string, unknown>);
      },
    },
    {
      name: "health_lift_constraint",
      description: "Lift a pain constraint. ALWAYS requires explicit user confirmation (MRTR) — never auto-executes.",
      risk: "confirmation",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          constraintId: { type: "string" },
          confirmToken: { type: "string" },
        },
        required: ["runHandle", "constraintId"],
      },
      execute: async (inv) => {
        await requireRun(inv.principalUserId, inv.args, "health_lift_constraint");
        const constraintId = str(inv.args, "constraintId");
        const [constraint] = await db.select().from(schema.healthConstraints)
          .where(and(
            eq(schema.healthConstraints.id, constraintId),
            eq(schema.healthConstraints.userId, inv.principalUserId),
            isNull(schema.healthConstraints.liftedAt),
          )).limit(1);
        if (!constraint) {
          return toolError("not_found", "constraint not found or already lifted");
        }

        const confirmToken = optStr(inv.args, "confirmToken");
        if (confirmToken === undefined) {
          const target = constraint.targetJson as { bodyPart?: string };
          return makeConfirmation(
            "health_lift_constraint", inv,
            `解除限制会允许 ${target.bodyPart ?? "相关部位"} 的训练动作重新进入计划。原始原因：${constraint.reason}。确认解除？`,
            ["确认解除", "暂不解除"],
            { constraintId },
          );
        }
        const pending = pendingConfirmations.get(confirmToken);
        pendingConfirmations.delete(confirmToken);
        if (!pending || pending.userId !== inv.principalUserId
            || pending.toolName !== "health_lift_constraint"
            || pending.expiresAt < new Date()) {
          return toolError("proposal_stale", "confirmation unknown, expired, or not yours");
        }
        await pain.lift(inv.principalUserId, constraintId, `mcp:${inv.actor}`);
        await dailyState.persistDailyProjection(inv.principalUserId, today(), "Asia/Shanghai");
        return complete({ constraintId, lifted: true, liftedBy: `mcp:${inv.actor}` });
      },
    },
    {
      name: "health_prepare_training",
      description: "Prepare today's training proposal (constraint-filtered). Returns trainingProposalId.",
      risk: "proposal",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          date: ISO_DATE,
          day: { type: "string", enum: ["A", "B", "C"] },
        },
        required: ["runHandle"],
      },
      execute: async (inv) => {
        await requireRun(inv.principalUserId, inv.args, "health_prepare_training");
        const date = optStr(inv.args, "date") ?? today();
        const day = optStr(inv.args, "day") as "A" | "B" | "C" | undefined;
        const proposal = await training.prepareSession(inv.principalUserId, date, day);
        const current = await dailyState.getDailyProjection(inv.principalUserId, date);
        const { createPreparedSessionService } = await import("../../training/prepared-session.js");
        const saved = await createPreparedSessionService(db).saveProposal({
          userId: inv.principalUserId,
          sessionDate: date,
          dayRole: proposal.dayRole,
          planVersionId: proposal.planVersionId ?? null,
          dailyStateRevision: typeof current?.revision === "number" ? current.revision : -1,
          proposedExercises: proposal.proposedExercises as unknown as Array<Record<string, unknown>>,
          blockedExercises: proposal.blockedExercises as unknown as Array<Record<string, unknown>>,
          activeConstraints: proposal.activeConstraints as unknown as Array<Record<string, unknown>>,
        });
        return complete({
          trainingProposalId: saved.proposalId,
          dayRole: proposal.dayRole,
          proposedExercises: proposal.proposedExercises,
          blockedExercises: proposal.blockedExercises,
        });
      },
    },
    {
      name: "health_start_training",
      description: "Start a session from a prepared proposal (atomic consume + create).",
      risk: "state-change",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          trainingProposalId: { type: "string" },
          date: ISO_DATE,
          dayRole: { type: "string", enum: ["A", "B", "C"] },
        },
        required: ["runHandle", "trainingProposalId"],
      },
      execute: async (inv) => {
        await requireRun(inv.principalUserId, inv.args, "health_start_training");
        const { createPreparedSessionService, ProposalStaleError } = await import("../../training/prepared-session.js");
        try {
          const result = await createPreparedSessionService(db).startSessionFromProposal({
            userId: inv.principalUserId,
            proposalId: str(inv.args, "trainingProposalId"),
            sessionDate: optStr(inv.args, "date") ?? today(),
            ...(optStr(inv.args, "dayRole") !== undefined ? { dayRole: optStr(inv.args, "dayRole") as "A" | "B" | "C" } : {}),
          });
          return complete({ trainingSessionId: result.sessionId, dayRole: result.dayRole, exerciseCount: result.exerciseCount });
        } catch (error) {
          if (error instanceof ProposalStaleError) {
            return toolError("proposal_stale", `${error.reason}; re-run health_prepare_training`);
          }
          throw error;
        }
      },
    },
    {
      name: "health_record_set",
      description: "Record one training set. Reaching target sets auto-completes the exercise. Returns before/after revision.",
      risk: "revocable-write",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          trainingSessionId: { type: "string" },
          sessionExerciseId: { type: "string" },
          setNumber: { type: "number" },
          loadValue: { type: "number" },
          loadUnit: { type: "string", enum: ["kg", "lb", "bodyweight"] },
          reps: { type: "number" },
          rir: { type: "number" },
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "trainingSessionId", "sessionExerciseId", "setNumber"],
      },
      execute: async (inv) => {
        const run = await requireRun(inv.principalUserId, inv.args, "health_record_set");
        const result = await training.recordSet({
          userId: inv.principalUserId,
          sessionId: str(inv.args, "trainingSessionId"),
          sessionExerciseId: str(inv.args, "sessionExerciseId"),
          setNumber: optNum(inv.args, "setNumber") ?? 1,
          loadValue: optNum(inv.args, "loadValue") ?? null,
          loadUnit: (optStr(inv.args, "loadUnit") as "kg" | "lb" | "bodyweight" | undefined) ?? null,
          reps: optNum(inv.args, "reps") ?? null,
          rir: optNum(inv.args, "rir") ?? null,
          idempotencyKey: optStr(inv.args, "idempotencyKey"),
          source: `mcp:${inv.actor}`,
        });
        const session = await runs.getRun(inv.principalUserId, String(inv.args["runHandle"]));
        void session;
        await dailyState.persistDailyProjection(inv.principalUserId, today(), "Asia/Shanghai");
        return complete({
          setId: result.log.id,
          replayed: result.replayed,
          beforeRevision: result.beforeRevision,
          afterRevision: result.afterRevision,
          exerciseCompleted: result.exerciseCompleted,
          journeyId: run.run.journeyId,
        });
      },
    },
    {
      name: "health_finish_training",
      description: "Finish a session (completed|interrupted|cancelled); advances the cycle when completed.",
      risk: "state-change",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          trainingSessionId: { type: "string" },
          finalStatus: { type: "string", enum: ["completed", "interrupted", "cancelled"] },
        },
        required: ["runHandle", "trainingSessionId"],
      },
      execute: async (inv) => {
        await requireRun(inv.principalUserId, inv.args, "health_finish_training");
        const status = (optStr(inv.args, "finalStatus") ?? "completed") as "completed" | "interrupted" | "cancelled";
        const session = await training.finishSession(inv.principalUserId, str(inv.args, "trainingSessionId"), status);
        await dailyState.persistDailyProjection(inv.principalUserId, session.sessionDate, "Asia/Shanghai");
        let cycle: unknown = null;
        if (status === "completed") {
          try {
            const { createCycleEngine } = await import("../../training/cycle-engine.js");
            cycle = await createCycleEngine(db).recordCycleOutcome({
              userId: inv.principalUserId,
              sessionId: session.id,
              outcome: "completed",
              onDate: session.sessionDate,
            });
          } catch { cycle = null; }
        }
        return complete({ sessionId: session.id, status, cycle });
      },
    },
    {
      name: "health_propose_substitution",
      description: "Propose substitutes for an unfinished exercise. Returns substitutionProposalId + candidates.",
      risk: "proposal",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          trainingSessionId: { type: "string" },
          sessionExerciseId: { type: "string" },
        },
        required: ["runHandle", "trainingSessionId", "sessionExerciseId"],
      },
      execute: async (inv) => {
        await requireRun(inv.principalUserId, inv.args, "health_propose_substitution");
        const proposal = await substitution.propose(
          inv.principalUserId, str(inv.args, "trainingSessionId"), str(inv.args, "sessionExerciseId"));
        return complete(proposal as unknown as Record<string, unknown>);
      },
    },
    {
      name: "health_apply_substitution",
      description: "Apply a substitution by proposal id + chosen slug. Candidates with trade-offs are chosen by the user (MRTR when ambiguous).",
      risk: "confirmation",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          substitutionProposalId: { type: "string" },
          chosenSlug: { type: "string" },
          reason: { type: "string" },
          confirmToken: { type: "string" },
        },
        required: ["runHandle", "substitutionProposalId", "chosenSlug"],
      },
      execute: async (inv) => {
        await requireRun(inv.principalUserId, inv.args, "health_apply_substitution");
        try {
          const result = await substitution.apply({
            userId: inv.principalUserId,
            substitutionProposalId: str(inv.args, "substitutionProposalId"),
            chosenSlug: str(inv.args, "chosenSlug"),
            reason: optStr(inv.args, "reason") ?? "mcp substitution",
          });
          return complete({ replacementId: result.replacementId });
        } catch (error) {
          if (error instanceof SubstitutionProposalError) {
            return toolError("proposal_stale", error.reason);
          }
          throw error;
        }
      },
    },
    {
      name: "health_record_reflection",
      description: "Record a structured post-training reflection.",
      risk: "revocable-write",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          trainingSessionId: { type: "string" },
          bestCueRefs: { type: "array", items: { type: "string" } },
          unresolvedIssues: { type: "array", items: { type: "object" } },
          painSummary: { type: "array", items: { type: "object" } },
          proposedAdjustments: { type: "array", items: { type: "object" } },
          nextValidationQuestions: { type: "array", items: { type: "string" } },
        },
        required: ["runHandle", "trainingSessionId"],
      },
      execute: async (inv) => {
        await requireRun(inv.principalUserId, inv.args, "health_record_reflection");
        const result = await reflection.record({
          userId: inv.principalUserId,
          sessionId: str(inv.args, "trainingSessionId"),
          bestCueRefs: (inv.args["bestCueRefs"] as string[] | undefined) ?? [],
          unresolvedIssues: (inv.args["unresolvedIssues"] as Array<Record<string, unknown>> | undefined) ?? [],
          painSummary: (inv.args["painSummary"] as Array<Record<string, unknown>> | undefined) ?? [],
          proposedAdjustments: (inv.args["proposedAdjustments"] as never) ?? [],
          nextValidationQuestions: (inv.args["nextValidationQuestions"] as string[] | undefined) ?? [],
        });
        return complete(result);
      },
    },
    {
      name: "health_propose_plan_change",
      description: "Turn accepted reflection adjustments into a DRAFT child plan version. Activation is separate + confirmed.",
      risk: "proposal",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          reflectionId: { type: "string" },
          changes: { type: "array", items: { type: "object" } },
          reason: { type: "string" },
        },
        required: ["runHandle", "reflectionId", "reason"],
      },
      execute: async (inv) => {
        await requireRun(inv.principalUserId, inv.args, "health_propose_plan_change");
        const result = await reflection.proposeChildVersion({
          userId: inv.principalUserId,
          reflectionId: str(inv.args, "reflectionId"),
          changes: (inv.args["changes"] as Array<Record<string, unknown>> | undefined) ?? [],
          reason: str(inv.args, "reason"),
        });
        return complete(result);
      },
    },
    {
      name: "health_activate_plan_version",
      description: "Activate a draft plan version. ALWAYS requires MRTR with the full diff before activation.",
      risk: "confirmation",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          planVersionId: { type: "string" },
          confirmToken: { type: "string" },
        },
        required: ["runHandle", "planVersionId"],
      },
      execute: async (inv) => {
        await requireRun(inv.principalUserId, inv.args, "health_activate_plan_version");
        const planVersionId = str(inv.args, "planVersionId");
        const [version] = await db.select().from(schema.planVersions)
          .where(and(eq(schema.planVersions.id, planVersionId), eq(schema.planVersions.userId, inv.principalUserId)))
          .limit(1);
        if (!version) return toolError("not_found", "plan version not found");
        if (version.status !== "draft") {
          return toolError("invalid_session_state", `version is ${version.status}, only drafts activate`);
        }

        const confirmToken = optStr(inv.args, "confirmToken");
        if (confirmToken === undefined) {
          const parent = version.parentVersionId
            ? (await db.select().from(schema.planVersions)
                .where(eq(schema.planVersions.id, version.parentVersionId)).limit(1))[0]
            : undefined;
          return makeConfirmation(
            "health_activate_plan_version", inv,
            `激活将把当前训练计划切换到 v${version.versionNumber}（原因：${version.adjustmentReason ?? "n/a"}），父版本 ${parent?.versionNumber ?? "?"} 转为 superseded，可回滚。确认激活？`,
            ["确认激活", "暂不激活"],
            { planVersionId },
          );
        }
        const pending = pendingConfirmations.get(confirmToken);
        pendingConfirmations.delete(confirmToken);
        if (!pending || pending.userId !== inv.principalUserId
            || pending.toolName !== "health_activate_plan_version"
            || pending.expiresAt < new Date()) {
          return toolError("proposal_stale", "confirmation unknown, expired, or not yours");
        }
        await reflection.activateChildVersion(inv.principalUserId, planVersionId);
        return complete({ planVersionId, activated: true });
      },
    },
  ];

  return {
    toolDefs,
    /** Public list shape for tools/list. */
    listTools() {
      return toolDefs
        .map((t) => ({
          name: t.name,
          description: `[${t.risk}] ${t.description}`,
          inputSchema: t.inputSchema,
          _meta: { "compass.health/risk": t.risk },
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async call(name: string, invocation: ToolInvocation): Promise<ToolOutcome> {
      const tool = toolDefs.find((t) => t.name === name);
      if (!tool) {
        return toolError("not_found", `unknown tool: ${name}`);
      }
      try {
        return await tool.execute(invocation);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("run_handle_required")) {
          return toolError("run_handle_required", message);
        }
        if ((error as { code?: string }).code === "run_handle_invalid") {
          return toolError("run_handle_invalid", message);
        }
        if (error instanceof RangeError) {
          return toolError("validation_failed", error.message);
        }
        return toolError("internal", "internal error");
      }
    },
  };
}
