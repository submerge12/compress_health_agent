/**
 * P2 / WO-MCP-3+4: canonical health tools (writes) + MRTR confirmation flows.
 *
 * Risk model (plan §七.3):
 * - read-only: no confirmation;
 * - revocable-write: direct execution, reversible via correction tools;
 * - proposal: persists a handle, never mutates;
 * - confirmation-required (MRTR): first call returns resultType
 *   "input_required" with durable requestState; the retry repeats the same
 *   original call and supplies inputResponses.
 *
 * Every write tool requires a runHandle (health_begin_run). Tool bodies stay
 * thin: they adapt the MCP surface to existing domain services — no health
 * rule lives here.
 */
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";

import * as schema from "../../db/schema.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createRepository, type Repository } from "../../db/repository.js";
import type { ToolContext } from "../../tools/context.js";
import {
  CandidateSelectionError,
  createDietLogService,
  NeedsConfirmationError,
  resolveConfirmedFoodCandidates,
  StateConflict,
} from "../../domain/diet-log-service.js";
import { createDailyStateService } from "../../domain/daily-state.js";
import { createProjectionWorker } from "../../domain/projection-worker.js";
import { createHealthRecordingService } from "../../domain/health-recording-service.js";
import { createMediaRetrieval } from "../../media/retrieval.js";
import { createPainCommand } from "../../training/prepared-session.js";
import { createTrainingService } from "../../training/training-service.js";
import { createSubstitutionEngine, SubstitutionProposalError } from "../../training/substitution-engine.js";
import { createReflectionEngine } from "../../training/reflection-engine.js";
import { createCycleEngine } from "../../training/cycle-engine.js";
import { handleSmartGenerateMealPlan } from "../../tools/handlers.js";
import type { NutritionEstimateResult } from "../../tools/nutrition-estimate.js";
import { createRunHandleService } from "../evidence/run-handles.js";
import {
  createRequestStateService,
  RequestStateError,
  type PendingInputBinding,
} from "../input/request-state.js";
import { createWriteCommandService, WriteCommandError } from "../writes/command.js";

type Db = PostgresJsDatabase<typeof schema>;

const ISO_DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } as const;

export interface ToolInvocation {
  principalUserId: string;
  actor: string;
  args: Record<string, unknown>;
  requestState?: string;
  confirmationChoice?: string;
  inputResponses?: Record<string, unknown>;
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
  requestState: string;
  inputRequests: Record<string, unknown>;
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

export function createHealthToolCatalog(
  db: Db,
  repo: Repository,
  options: { toolContext?: ToolContext; conformanceProfile?: boolean } = {},
) {
  const runs = createRunHandleService(db);
  const diet = createDietLogService(db, repo);
  const requestStates = createRequestStateService(db);
  const writes = createWriteCommandService(db);

  const CONFIRMATION_TTL_MS = 10 * 60_000;

  async function makeConfirmation(
    toolName: string,
    targetId: string,
    invocation: ToolInvocation,
    prompt: string,
    choices: string[],
    payload: Record<string, unknown>,
    inputRequests?: Record<string, unknown>,
  ): Promise<ToolOutcome> {
    const issued = await requestStates.issue({
      toolName,
      targetId,
      runHandle: str(invocation.args, "runHandle"),
      userId: invocation.principalUserId,
      verifiedActor: invocation.actor,
      idempotencyKey: str(invocation.args, "idempotencyKey"),
      arguments: invocation.args,
      prompt,
      choices,
      ...(inputRequests ? { inputRequests } : {}),
      payload,
      ttlMs: CONFIRMATION_TTL_MS,
    });
    await runs.recordStep({
      userId: invocation.principalUserId,
      runHandle: str(invocation.args, "runHandle"),
      stage: "confirmation",
      mcpMethod: "tools/call",
      mcpName: toolName,
      aggregateType: "pending_input_request",
      aggregateId: targetId,
      arguments: invocation.args,
      resultSummary: { targetId, expiresAt: issued.expiresAt },
    });
    return inputRequired({
      requestState: issued.requestState,
      inputRequests: issued.inputRequests,
      expiresAt: issued.expiresAt,
    });
  }

  function pendingBinding(
    toolName: string,
    targetId: string,
    invocation: ToolInvocation,
  ): PendingInputBinding {
    return {
      userId: invocation.principalUserId,
      verifiedActor: invocation.actor,
      runHandle: str(invocation.args, "runHandle"),
      toolName,
      targetId,
      idempotencyKey: str(invocation.args, "idempotencyKey"),
      arguments: invocation.args,
    };
  }

  function writeInput(invocation: ToolInvocation, toolName: string, scopeKey: string) {
    const runHandle = invocation.args["runHandle"];
    if (typeof runHandle !== "string" || runHandle.trim() === "") {
      throw new Error("run_handle_required: call health_begin_run first; writes without a run are not accepted");
    }
    return {
      userId: invocation.principalUserId,
      verifiedActor: invocation.actor,
      runHandle: runHandle.trim(),
      toolName,
      scopeKey,
      idempotencyKey: str(invocation.args, "idempotencyKey"),
      arguments: invocation.args,
    };
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

  function acceptedSelections(responses: Record<string, unknown> | undefined): Record<string, string> {
    const selections: Record<string, string> = {};
    for (const [key, raw] of Object.entries(responses ?? {})) {
      const response = raw as { action?: unknown; content?: { choice?: unknown } };
      if (response.action === "accept" && typeof response.content?.choice === "string") {
        selections[key] = response.content.choice;
      }
    }
    return selections;
  }

  function today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  function addDays(date: string, days: number): string {
    const value = new Date(`${date}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  }

  async function buildToolContext(userId: string): Promise<ToolContext> {
    const context = options.toolContext;
    if (!context || context.userId !== userId) {
      throw new Error("tool context user mismatch");
    }
    return context;
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
      risk: "state-change",
      inputSchema: {
        type: "object",
        properties: {
          objective: { type: "string", description: "What this journey tries to do (one line)." },
          inputChannel: { type: "string", enum: ["gpt-live", "xiaomi-voice", "mcp", "web"] },
          idempotencyKey: { type: "string" },
        },
        required: ["objective", "idempotencyKey"],
      },
      execute: async (inv) => {
        const result = await writes.beginRun({
          userId: inv.principalUserId,
          objective: str(inv.args, "objective"),
          inputChannel: optStr(inv.args, "inputChannel") ?? "mcp",
          verifiedActor: inv.actor,
          idempotencyKey: str(inv.args, "idempotencyKey"),
          arguments: inv.args,
        });
        return complete(result.response);
      },
    },
    {
      name: "health_end_run",
      description: "Close a run with its outcome and the user's acceptance signal.",
      risk: "state-change",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          outcome: { type: "string", enum: ["completed", "failed", "abandoned"] },
          responseSummary: { type: "string" },
          userAccepted: { type: "boolean" },
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "outcome", "idempotencyKey"],
      },
      execute: async (inv) => {
        const outcome = str(inv.args, "outcome") as "completed" | "failed" | "abandoned";
        if (!["completed", "failed", "abandoned"].includes(outcome)) {
          return toolError("validation_failed", "outcome must be completed|failed|abandoned");
        }
        const runHandle = str(inv.args, "runHandle");
        const result = await writes.execute(
          writeInput(inv, "health_end_run", runHandle),
          async (tx) => {
            const [updated] = await tx.update(schema.agentRuns).set({
              outcome,
              finishedAt: new Date(),
              updatedAt: new Date(),
              ...(optStr(inv.args, "responseSummary")
                ? { responseSummary: optStr(inv.args, "responseSummary")!.slice(0, 1000) }
                : {}),
            }).where(and(
              eq(schema.agentRuns.id, runHandle),
              eq(schema.agentRuns.userId, inv.principalUserId),
              eq(schema.agentRuns.outcome, "running"),
            )).returning();
            if (!updated) throw new WriteCommandError("run_handle_invalid", "run is already closed");
            const [outbox] = await tx.insert(schema.outboxEvents).values({
              userId: inv.principalUserId,
              aggregateType: "user_decision",
              aggregateId: runHandle,
              eventType: "agent.run_ended",
              payloadJson: { outcome, journeyId: updated.journeyId },
            }).returning({ id: schema.outboxEvents.id });
            const [count] = await tx.select({ n: sql<number>`count(*)::int` })
              .from(schema.agentRunSteps)
              .where(eq(schema.agentRunSteps.runId, runHandle));
            if (!outbox) throw new Error("run end outbox insert failed");
            return {
              response: { runHandle, outcome: updated.outcome, stepCount: (count?.n ?? 0) + 1 },
              factRefs: [{ type: "agent_run", id: runHandle }],
              outboxEventIds: [outbox.id],
            };
          },
        );
        return complete(result.response);
      },
    },
    {
      name: "health_generate_diet_plan",
      description: "Generate and persist a seven-day diet plan through the existing smart meal planner.",
      risk: "state-change",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          startDate: ISO_DATE,
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "idempotencyKey"],
      },
      execute: async (inv) => {
        const ctx = await buildToolContext(inv.principalUserId);
        const startDate = optStr(inv.args, "startDate") ?? addDays(today(), 1);
        const endDate = addDays(startDate, 6);
        const result = await writes.execute(
          writeInput(inv, "health_generate_diet_plan", startDate),
          async (tx) => {
            const txDb = tx as unknown as Db;
            const txRepo = createRepository(txDb);
            const txCtx: ToolContext = { ...ctx, db: txDb, repo: txRepo };
            const generated = await handleSmartGenerateMealPlan(txCtx, { startDate });
            const rows = await tx.select().from(schema.mealPlanEntries)
              .where(and(
                eq(schema.mealPlanEntries.userId, inv.principalUserId),
                gte(schema.mealPlanEntries.planDate, startDate),
                lte(schema.mealPlanEntries.planDate, endDate),
              ));
            const factRefs: Array<{ type: string; id: string }> = rows.map((row) => ({
              type: "meal_plan_entry",
              id: row.id,
            }));
            if (factRefs.length === 0) {
              const [decision] = await tx.insert(schema.userDecisionEvents).values({
                userId: inv.principalUserId,
                decisionType: "modified",
                subjectJson: { type: "diet_plan_generation", startDate, status: generated.status },
              }).returning();
              if (!decision) throw new Error("diet plan attempt fact insert failed");
              factRefs.push({ type: "user_decision", id: decision.id });
            }
            const [outbox] = await tx.insert(schema.outboxEvents).values({
              userId: inv.principalUserId,
              aggregateType: "user_decision",
              aggregateId: startDate,
              eventType: "diet.plan_generated",
              payloadJson: { observedOn: startDate, endDate, status: generated.status, entries: rows.length },
            }).returning({ id: schema.outboxEvents.id });
            if (!outbox) throw new Error("diet plan outbox insert failed");
            return {
              response: {
                startDate,
                endDate,
                entryCount: rows.length,
                generation: generated,
              } as unknown as Record<string, unknown>,
              factRefs,
              outboxEventIds: [outbox.id],
            };
          },
        );
        return complete(result.response);
      },
    },
    {
      name: "health_get_diet_plan",
      description: "Read persisted diet-plan entries for a date range.",
      risk: "read-only",
      inputSchema: {
        type: "object",
        properties: {
          startDate: ISO_DATE,
          endDate: ISO_DATE,
          runHandle: { type: "string" },
        },
        required: ["startDate"],
      },
      execute: async (inv) => {
        const startDate = str(inv.args, "startDate");
        const endDate = optStr(inv.args, "endDate") ?? addDays(startDate, 6);
        const entries = await db.select().from(schema.mealPlanEntries)
          .where(and(
            eq(schema.mealPlanEntries.userId, inv.principalUserId),
            gte(schema.mealPlanEntries.planDate, startDate),
            lte(schema.mealPlanEntries.planDate, endDate),
          )).orderBy(schema.mealPlanEntries.planDate, schema.mealPlanEntries.mealType);
        const runHandle = optStr(inv.args, "runHandle");
        if (runHandle) {
          await runs.recordStep({
            userId: inv.principalUserId,
            runHandle,
            stage: "tool_call",
            mcpMethod: "tools/call",
            mcpName: "health_get_diet_plan",
            arguments: inv.args,
            resultSummary: { startDate, endDate, entryCount: entries.length },
          });
        }
        return complete({ startDate, endDate, entries });
      },
    },
    {
      name: "health_search_training_media",
      description: "Search safe, usable training-video segments without exposing local file paths.",
      risk: "read-only",
      inputSchema: {
        type: "object",
        properties: {
          movementPattern: { type: "string" },
          bodyPart: { type: "string" },
          category: { type: "string" },
          text: { type: "string" },
          limit: { type: "number" },
        },
      },
      execute: async (inv) => {
        const segments = await createMediaRetrieval(db).search({
          ...(optStr(inv.args, "movementPattern") ? { movementPattern: optStr(inv.args, "movementPattern") } : {}),
          ...(optStr(inv.args, "bodyPart") ? { bodyPart: optStr(inv.args, "bodyPart") } : {}),
          ...(optStr(inv.args, "category") ? { category: optStr(inv.args, "category") } : {}),
          ...(optStr(inv.args, "text") ? { text: optStr(inv.args, "text") } : {}),
          ...(optNum(inv.args, "limit") ? { limit: Math.min(50, Math.max(1, Math.round(optNum(inv.args, "limit")!))) } : {}),
        });
        return complete({ segments });
      },
    },
    {
      name: "health_record_media_feedback",
      description: "Record whether a training-video segment was helpful.",
      risk: "revocable-write",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          segmentId: { type: "string" },
          helpful: { type: "boolean" },
          note: { type: "string" },
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "segmentId", "helpful", "idempotencyKey"],
      },
      execute: async (inv) => {
        const segmentId = str(inv.args, "segmentId");
        const helpful = inv.args["helpful"] === true;
        const result = await writes.execute(
          writeInput(inv, "health_record_media_feedback", segmentId),
          async (tx) => {
            const [segment] = await tx.select().from(schema.videoSegments)
              .where(eq(schema.videoSegments.id, segmentId)).limit(1);
            if (!segment) throw new RangeError("media segment not found");
            const feedback = await createMediaRetrieval(tx as unknown as Db)
              .recordFeedback(inv.principalUserId, segmentId, helpful, optStr(inv.args, "note"));
            const [readBack] = await tx.select().from(schema.segmentFeedback)
              .where(and(
                eq(schema.segmentFeedback.id, feedback.feedbackId),
                eq(schema.segmentFeedback.userId, inv.principalUserId),
              )).limit(1);
            const [outbox] = await tx.insert(schema.outboxEvents).values({
              userId: inv.principalUserId,
              aggregateType: "user_decision",
              aggregateId: feedback.feedbackId,
              eventType: "media.feedback_recorded",
              payloadJson: { observedOn: today(), segmentId, helpful },
            }).returning({ id: schema.outboxEvents.id });
            if (!readBack || !outbox) throw new Error("media feedback read-back failed");
            return {
              response: { feedbackId: readBack.id, segmentId, helpful },
              factRefs: [{ type: "media_feedback", id: readBack.id }],
              outboxEventIds: [outbox.id],
            };
          },
        );
        return complete(result.response);
      },
    },
    {
      name: "health_get_projection_diagnostics",
      description: "Read daily-state projection, checkpoint, pending outbox, and dead-letter diagnostics.",
      risk: "read-only",
      inputSchema: {
        type: "object",
        properties: { date: ISO_DATE },
      },
      execute: async (inv) => complete(await createProjectionWorker(db, repo)
        .getDiagnostics(inv.principalUserId, optStr(inv.args, "date") ?? today())),
    },
    {
      name: "health_replay_projection",
      description: "Requeue this user's dead letters and rebuild one daily-state projection.",
      risk: "state-change",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          date: ISO_DATE,
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "idempotencyKey"],
      },
      execute: async (inv) => {
        const date = optStr(inv.args, "date") ?? today();
        const result = await writes.execute(
          writeInput(inv, "health_replay_projection", date),
          async (tx) => {
            const txDb = tx as unknown as Db;
            const worker = createProjectionWorker(txDb, createRepository(txDb));
            const revived = await worker.replayDeadLetters(inv.principalUserId, date);
            await worker.rebuildUserProjection(inv.principalUserId, date);
            const [projection] = await tx.select().from(schema.dailyHealthStateProjection)
              .where(and(
                eq(schema.dailyHealthStateProjection.userId, inv.principalUserId),
                eq(schema.dailyHealthStateProjection.stateDate, date),
              )).limit(1);
            if (!projection) throw new Error("projection replay read-back failed");
            const [outbox] = await tx.insert(schema.outboxEvents).values({
              userId: inv.principalUserId,
              aggregateType: "user_decision",
              aggregateId: `${inv.principalUserId}:${date}`,
              eventType: "projection.replayed",
              payloadJson: { observedOn: date, revived },
            }).returning({ id: schema.outboxEvents.id });
            if (!outbox) throw new Error("projection replay outbox failed");
            return {
              response: { date, revived, revision: projection.revision, status: projection.projectionStatus },
              factRefs: [{ type: "daily_state_projection", id: `${inv.principalUserId}:${date}` }],
              outboxEventIds: [outbox.id],
            };
          },
        );
        return complete(result.response);
      },
    },
    {
      name: "health_get_run_evidence",
      description: "Read the redacted evidence timeline for an owned runHandle.",
      risk: "read-only",
      inputSchema: {
        type: "object",
        properties: { runHandle: { type: "string" } },
        required: ["runHandle"],
      },
      execute: async (inv) => complete(await runs.getRun(
        inv.principalUserId,
        str(inv.args, "runHandle"),
      )),
    },
    {
      name: "health_acknowledge_rest",
      description: "Acknowledge a REST recommendation and advance the explicit training cycle.",
      risk: "state-change",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          date: ISO_DATE,
          reason: { type: "string" },
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "idempotencyKey"],
      },
      execute: async (inv) => {
        const date = optStr(inv.args, "date") ?? today();
        const result = await writes.execute(
          writeInput(inv, "health_acknowledge_rest", date),
          async (tx) => {
            const acknowledged = await createCycleEngine(tx as unknown as Db).acknowledgeRest({
              userId: inv.principalUserId,
              ...(optStr(inv.args, "reason") ? { reasonCode: optStr(inv.args, "reason") } : {}),
              onDate: date,
            });
            const [readBack] = await tx.select().from(schema.trainingCyclePositions)
              .where(and(
                eq(schema.trainingCyclePositions.cycleInstanceId, acknowledged.cycleInstanceId),
                eq(schema.trainingCyclePositions.positionIndex, acknowledged.positionIndex),
                eq(schema.trainingCyclePositions.userId, inv.principalUserId),
              )).limit(1);
            const [userDecision] = await tx.insert(schema.userDecisionEvents).values({
              userId: inv.principalUserId,
              decisionType: "accepted",
              subjectJson: { type: "rest_acknowledgement", date, reasonCodes: acknowledged.reasonCodes },
            }).returning();
            if (!readBack || !userDecision) throw new Error("rest acknowledgement read-back failed");
            const [outbox] = await tx.insert(schema.outboxEvents).values({
              userId: inv.principalUserId,
              aggregateType: "user_decision",
              aggregateId: userDecision.id,
              eventType: "training.rest_acknowledged",
              payloadJson: { observedOn: date, cycleInstanceId: acknowledged.cycleInstanceId },
            }).returning({ id: schema.outboxEvents.id });
            if (!outbox) throw new Error("rest acknowledgement outbox failed");
            return {
              response: {
                acknowledged: true,
                date,
                cycleInstanceId: acknowledged.cycleInstanceId,
                positionIndex: acknowledged.positionIndex,
                status: readBack.status,
                reasonCodes: acknowledged.reasonCodes,
              },
              factRefs: [
                { type: "training_cycle_position", id: readBack.id },
                { type: "user_decision", id: userDecision.id },
              ],
              outboxEventIds: [outbox.id],
            };
          },
        );
        return complete(result.response);
      },
    },
    {
      name: "health_log_meal",
      description: "Log a meal by description. Ambiguous items return standard MCP input_required candidate choices.",
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
        },
        required: ["runHandle", "mealType", "description", "idempotencyKey"],
      },
      execute: async (inv) => {
        await requireRun(inv.principalUserId, inv.args, "health_log_meal");
        const ctx = await buildToolContext(inv.principalUserId);
        try {
          const idempotencyKey = str(inv.args, "idempotencyKey");

          // MRTR retry path: apply the user's confirmed resolution.
          if (inv.requestState !== undefined) {
            const targetId = `diet:${optStr(inv.args, "date") ?? today()}:${str(inv.args, "mealType")}`;
            const committed = await requestStates.consume(
              inv.requestState,
              pendingBinding("health_log_meal", targetId, inv),
              async (tx, pending) => {
                const payload = pending.payloadJson as {
                  date: string;
                  mealType: string;
                  description: string;
                  estimate: NutritionEstimateResult;
                };
                const txDb = tx as unknown as Db;
                const txCtx: ToolContext = { ...ctx, db: txDb };
                const resolved = await resolveConfirmedFoodCandidates(
                  txCtx,
                  payload.estimate,
                  acceptedSelections(inv.inputResponses),
                );
                return writes.executeInTransaction(
                  tx,
                  writeInput(inv, "health_log_meal", targetId),
                  async (writeTx) => {
                    const writeDb = writeTx as unknown as Db;
                    const writeCtx: ToolContext = { ...txCtx, db: writeDb };
                    const result = await createDietLogService(writeDb, repo).commit(writeCtx, {
                      userId: inv.principalUserId,
                      logDate: payload.date,
                      mealType: payload.mealType,
                      description: payload.description,
                      idempotencyKey,
                      overrideEstimate: resolved,
                    });
                    const [readBack] = await writeTx.select().from(schema.dietLogs)
                      .where(and(
                        eq(schema.dietLogs.id, result.log.id),
                        eq(schema.dietLogs.userId, inv.principalUserId),
                      )).limit(1);
                    const outbox = await writeTx.select({ id: schema.outboxEvents.id })
                      .from(schema.outboxEvents)
                      .where(and(
                        eq(schema.outboxEvents.userId, inv.principalUserId),
                        eq(schema.outboxEvents.aggregateId, result.log.id),
                      ));
                    if (!readBack || outbox.length === 0) throw new Error("diet write read-back failed");
                    return {
                      response: {
                        dietLogId: readBack.id,
                        caloriesKcal: readBack.caloriesKcal,
                        confirmed: inv.confirmationChoice,
                      },
                      factRefs: [{ type: "diet_log", id: readBack.id }],
                      outboxEventIds: outbox.map((event) => event.id),
                    };
                  },
                );
              },
            );
            return complete(committed.response);
          }

          // First call: preview; ambiguous -> MRTR.
          const previewResult = await diet.preview(ctx, {
            description: str(inv.args, "description"),
            date: optStr(inv.args, "date") ?? today(),
            mealType: str(inv.args, "mealType"),
          });
          if (previewResult.status === "needs_confirmation") {
            const estimate = previewResult.estimate as {
              needsConfirmation?: Array<{ segment?: string; candidates?: Array<{ slug?: string; label?: string }> }>;
              unmatched?: Array<{ segment?: string }>;
            };
            const promptItems = [
              ...(estimate.needsConfirmation ?? []).map((n) => n.segment ?? "item"),
              ...(estimate.unmatched ?? []).map((n) => `${n.segment ?? "item"} (未匹配)`,
              ),
            ];
            const date = optStr(inv.args, "date") ?? today();
            const mealType = str(inv.args, "mealType");
            const inputRequests: Record<string, unknown> = {};
            (estimate.needsConfirmation ?? []).forEach((diagnostic, index) => {
              inputRequests[`candidate_${index}`] = {
                method: "elicitation/create",
                params: {
                  mode: "form",
                  message: `请选择“${diagnostic.segment ?? "item"}”对应的食物`,
                  requestedSchema: {
                    type: "object",
                    properties: {
                      choice: {
                        type: "string",
                        enum: (diagnostic.candidates ?? [])
                          .map((candidate) => candidate.slug ?? candidate.label ?? "")
                          .filter((candidate) => candidate !== ""),
                      },
                    },
                    required: ["choice"],
                  },
                },
              };
            });
            (estimate.unmatched ?? []).forEach((diagnostic, index) => {
              inputRequests[`unmatched_${index}`] = {
                method: "elicitation/create",
                params: {
                  mode: "form",
                  message: `请输入“${diagnostic.segment ?? "item"}”对应的明确食物名称`,
                  requestedSchema: {
                    type: "object",
                    properties: { choice: { type: "string" } },
                    required: ["choice"],
                  },
                },
              };
            });
            return await makeConfirmation(
              "health_log_meal", `diet:${date}:${mealType}`, inv,
              `这些食材需要确认：${promptItems.join("、") || "份量不确定"}`,
              [],
              {
                date,
                mealType,
                description: str(inv.args, "description"),
                estimate: previewResult.estimate as unknown as Record<string, unknown>,
              },
              inputRequests,
            );
          }

          // Clean estimate -> commit directly.
          const date = optStr(inv.args, "date") ?? today();
          const mealType = str(inv.args, "mealType");
          const targetId = `diet:${date}:${mealType}`;
          const committed = await writes.execute(
            writeInput(inv, "health_log_meal", targetId),
            async (tx) => {
              const txDb = tx as unknown as Db;
              const txCtx: ToolContext = { ...ctx, db: txDb };
              const result = await createDietLogService(txDb, repo).commit(txCtx, {
                userId: inv.principalUserId,
                logDate: date,
                mealType,
                description: str(inv.args, "description"),
                idempotencyKey,
                ...(optNum(inv.args, "expectedRevision") !== undefined
                  ? { expectedRevision: optNum(inv.args, "expectedRevision") } : {}),
              });
              const [readBack] = await tx.select().from(schema.dietLogs)
                .where(and(
                  eq(schema.dietLogs.id, result.log.id),
                  eq(schema.dietLogs.userId, inv.principalUserId),
                )).limit(1);
              const outbox = await tx.select({ id: schema.outboxEvents.id }).from(schema.outboxEvents)
                .where(and(
                  eq(schema.outboxEvents.userId, inv.principalUserId),
                  eq(schema.outboxEvents.aggregateId, result.log.id),
                ));
              if (!readBack || outbox.length === 0) throw new Error("diet write read-back failed");
              return {
                response: { dietLogId: readBack.id, caloriesKcal: readBack.caloriesKcal },
                factRefs: [{ type: "diet_log", id: readBack.id }],
                outboxEventIds: outbox.map((event) => event.id),
              };
            },
          );
          return complete(committed.response);
        } catch (error) {
          if (error instanceof NeedsConfirmationError) {
            return toolError("proposal_stale", "nutrition estimate changed; retry the original call");
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
        required: ["runHandle", "dietLogId", "idempotencyKey"],
      },
      execute: async (inv) => {
        await requireRun(inv.principalUserId, inv.args, "health_correct_meal");
        const ctx = await buildToolContext(inv.principalUserId);
        const originalLogId = str(inv.args, "dietLogId");
        const result = await writes.execute(
          writeInput(inv, "health_correct_meal", originalLogId),
          async (tx) => {
            const txDb = tx as unknown as Db;
            const txCtx: ToolContext = { ...ctx, db: txDb };
            const corrected = await createDietLogService(txDb, repo).correct(txCtx, {
              userId: inv.principalUserId,
              originalLogId,
              ...(optStr(inv.args, "description") ? { description: optStr(inv.args, "description") } : {}),
              ...(optStr(inv.args, "mealType") ? { mealType: optStr(inv.args, "mealType") } : {}),
              reason: optStr(inv.args, "reason") ?? "mcp correction",
              idempotencyKey: str(inv.args, "idempotencyKey"),
            });
            const [readBack] = await tx.select().from(schema.dietLogs)
              .where(and(
                eq(schema.dietLogs.id, corrected.revised.id),
                eq(schema.dietLogs.userId, inv.principalUserId),
              )).limit(1);
            const outbox = await tx.select({ id: schema.outboxEvents.id }).from(schema.outboxEvents)
              .where(and(
                eq(schema.outboxEvents.userId, inv.principalUserId),
                eq(schema.outboxEvents.aggregateId, corrected.revised.id),
              ));
            if (!readBack || outbox.length === 0) throw new Error("diet correction read-back failed");
            return {
              response: {
                correctedLogId: readBack.id,
                supersededLogId: corrected.original.id,
                caloriesKcal: readBack.caloriesKcal,
              },
              factRefs: [{ type: "diet_log", id: readBack.id }],
              outboxEventIds: outbox.map((event) => event.id),
            };
          },
        );
        return complete(result.response);
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
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "amountMl", "idempotencyKey"],
      },
      execute: async (inv) => {
        const date = optStr(inv.args, "date") ?? today();
        const result = await writes.execute(writeInput(inv, "health_record_water", date), async (tx) => {
          const recorded = await createHealthRecordingService(tx as unknown as Db).recordWater({
            userId: inv.principalUserId,
            date,
            amountMl: inv.args["amountMl"],
            source: `mcp:${inv.actor}`,
          });
          return {
            response: { waterLogId: recorded.log.id, amountMl: recorded.log.amountMl },
            factRefs: [{ type: "water_log", id: recorded.log.id }],
            outboxEventIds: [recorded.outboxId],
          };
        });
        return complete(result.response);
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
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "activityType", "durationMinutes", "idempotencyKey"],
      },
      execute: async (inv) => {
        const date = optStr(inv.args, "date") ?? today();
        const result = await writes.execute(
          writeInput(inv, "health_record_activity", date),
          async (tx) => {
            const recorded = await createHealthRecordingService(tx as unknown as Db).recordActivity({
              userId: inv.principalUserId,
              date,
              activityType: inv.args["activityType"],
              durationMinutes: inv.args["durationMinutes"],
              caloriesBurnedKcal: inv.args["caloriesBurnedKcal"],
            });
            return {
              response: { activityId: recorded.log.id, durationMinutes: recorded.log.durationMinutes },
              factRefs: [{ type: "activity_log", id: recorded.log.id }],
              outboxEventIds: [recorded.outboxId],
            };
          },
        );
        return complete(result.response);
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
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "hours", "idempotencyKey"],
      },
      execute: async (inv) => {
        const date = optStr(inv.args, "date") ?? today();
        const result = await writes.execute(
          writeInput(inv, "health_record_sleep", date),
          async (tx) => {
            const recorded = await createHealthRecordingService(tx as unknown as Db).recordSleep({
              userId: inv.principalUserId,
              date,
              hours: inv.args["hours"],
              source: `mcp:${inv.actor}`,
            });
            const hours = (recorded.observation.valueJson as { hours: number }).hours;
            return {
              response: { observationId: recorded.observation.id, hours },
              factRefs: [{ type: "observation", id: recorded.observation.id }],
              outboxEventIds: [recorded.outboxId],
            };
          },
        );
        return complete(result.response);
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
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "level", "scope", "idempotencyKey"],
      },
      execute: async (inv) => {
        const date = optStr(inv.args, "date") ?? today();
        const result = await writes.execute(
          writeInput(inv, "health_record_fatigue", date),
          async (tx) => {
            const recorded = await createHealthRecordingService(tx as unknown as Db).recordFatigue({
              userId: inv.principalUserId,
              date,
              level: inv.args["level"],
              scope: inv.args["scope"],
              feedback: inv.args["feedback"],
              source: `mcp:${inv.actor}`,
            });
            const value = recorded.observation.valueJson as { level: number; scope: string };
            return {
              response: { observationId: recorded.observation.id, level: value.level, scope: value.scope },
              factRefs: [{ type: "observation", id: recorded.observation.id }],
              outboxEventIds: [recorded.outboxId],
            };
          },
        );
        return complete(result.response);
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
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "bodyPart", "severity", "idempotencyKey"],
      },
      execute: async (inv) => {
        const date = optStr(inv.args, "date") ?? today();
        const result = await writes.execute(
          writeInput(inv, "health_report_pain", date),
          async (tx) => {
            const command = await createPainCommand(tx as unknown as Db).execute({
              userId: inv.principalUserId,
              observedOn: date,
              bodyPart: str(inv.args, "bodyPart"),
              severityHint: str(inv.args, "severity") as never,
              ...(optStr(inv.args, "description") ? { description: optStr(inv.args, "description") } : {}),
            });
            const [constraint] = await tx.select().from(schema.healthConstraints)
              .where(and(
                eq(schema.healthConstraints.id, command.constraintId),
                eq(schema.healthConstraints.userId, inv.principalUserId),
              )).limit(1);
            const [observation] = await tx.select().from(schema.healthObservationEvents)
              .where(and(
                eq(schema.healthObservationEvents.id, command.observationId),
                eq(schema.healthObservationEvents.userId, inv.principalUserId),
              )).limit(1);
            const outbox = await tx.select({ id: schema.outboxEvents.id }).from(schema.outboxEvents)
              .where(and(
                eq(schema.outboxEvents.userId, inv.principalUserId),
                eq(schema.outboxEvents.aggregateId, command.constraintId),
              ));
            if (!constraint || !observation || outbox.length === 0) {
              throw new Error("pain write read-back failed");
            }
            return {
              response: command as unknown as Record<string, unknown>,
              factRefs: [
                { type: "observation", id: observation.id },
                { type: "constraint", id: constraint.id },
              ],
              outboxEventIds: outbox.map((event) => event.id),
            };
          },
        );
        return complete(result.response);
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
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "constraintId", "idempotencyKey"],
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

        if (inv.requestState === undefined) {
          const target = constraint.targetJson as { bodyPart?: string };
          return await makeConfirmation(
            "health_lift_constraint", constraintId, inv,
            `解除限制会允许 ${target.bodyPart ?? "相关部位"} 的训练动作重新进入计划。原始原因：${constraint.reason}。确认解除？`,
            ["确认解除", "暂不解除"],
            { constraintId },
          );
        }
        const result = await requestStates.consume(
          inv.requestState,
          pendingBinding("health_lift_constraint", constraintId, inv),
          async (tx) => {
            return writes.executeInTransaction(
              tx,
              writeInput(inv, "health_lift_constraint", constraintId),
              async (writeTx) => {
                const confirmed = inv.confirmationChoice === "确认解除";
                const resolved = await createPainCommand(writeTx as unknown as Db).resolveLift({
                  userId: inv.principalUserId,
                  constraintId,
                  actor: `mcp:${inv.actor}`,
                  confirmed,
                });
                return {
                  response: confirmed
                    ? { constraintId, lifted: true, liftedBy: `mcp:${inv.actor}` }
                    : { constraintId, lifted: false, declined: true },
                  factRefs: confirmed
                    ? [{ type: "constraint", id: resolved.constraint.id }, { type: "user_decision", id: resolved.decisionId }]
                    : [{ type: "user_decision", id: resolved.decisionId }],
                  outboxEventIds: [resolved.outboxId],
                };
              },
            );
          },
        );
        return complete(result.response);
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
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "idempotencyKey"],
      },
      execute: async (inv) => {
        const date = optStr(inv.args, "date") ?? today();
        const day = optStr(inv.args, "day") as "A" | "B" | "C" | undefined;
        const result = await writes.execute(
          writeInput(inv, "health_prepare_training", `${date}:${day ?? "cycle"}`),
          async (tx) => {
            const txDb = tx as unknown as Db;
            const proposal = await createTrainingService(txDb)
              .prepareSession(inv.principalUserId, date, day);
            const current = await createDailyStateService(txDb, repo)
              .getDailyProjection(inv.principalUserId, date);
            const { createPreparedSessionService } = await import("../../training/prepared-session.js");
            const saved = await createPreparedSessionService(txDb).saveProposal({
              userId: inv.principalUserId,
              sessionDate: date,
              dayRole: proposal.dayRole,
              planVersionId: proposal.planVersionId ?? null,
              dailyStateRevision: typeof current?.revision === "number" ? current.revision : -1,
              proposedExercises: proposal.proposedExercises as unknown as Array<Record<string, unknown>>,
              blockedExercises: proposal.blockedExercises as unknown as Array<Record<string, unknown>>,
              activeConstraints: proposal.activeConstraints as unknown as Array<Record<string, unknown>>,
            });
            const [outbox] = await tx.insert(schema.outboxEvents).values({
              userId: inv.principalUserId,
              aggregateType: "training_session",
              aggregateId: saved.proposalId,
              eventType: "training.prepared",
              payloadJson: { observedOn: date, dayRole: proposal.dayRole },
            }).returning({ id: schema.outboxEvents.id });
            const [readBack] = await tx.select().from(schema.preparedTrainingProposals)
              .where(and(
                eq(schema.preparedTrainingProposals.id, saved.proposalId),
                eq(schema.preparedTrainingProposals.userId, inv.principalUserId),
              )).limit(1);
            if (!outbox || !readBack) throw new Error("training proposal read-back failed");
            return {
              response: {
                trainingProposalId: readBack.id,
                dayRole: proposal.dayRole,
                proposedExercises: proposal.proposedExercises,
                blockedExercises: proposal.blockedExercises,
              },
              factRefs: [{ type: "training_proposal", id: readBack.id }],
              outboxEventIds: [outbox.id],
            };
          },
        );
        return complete(result.response);
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
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "trainingProposalId", "idempotencyKey"],
      },
      execute: async (inv) => {
        const { createPreparedSessionService, ProposalStaleError } = await import("../../training/prepared-session.js");
        try {
          const proposalId = str(inv.args, "trainingProposalId");
          const result = await writes.execute(
            writeInput(inv, "health_start_training", proposalId),
            async (tx) => {
              const started = await createPreparedSessionService(tx as unknown as Db)
                .startSessionFromProposal({
                  userId: inv.principalUserId,
                  proposalId,
                  sessionDate: optStr(inv.args, "date") ?? today(),
                  ...(optStr(inv.args, "dayRole") !== undefined
                    ? { dayRole: optStr(inv.args, "dayRole") as "A" | "B" | "C" }
                    : {}),
                });
              const [readBack] = await tx.select().from(schema.trainingSessions)
                .where(and(
                  eq(schema.trainingSessions.id, started.sessionId),
                  eq(schema.trainingSessions.userId, inv.principalUserId),
                )).limit(1);
              const outbox = await tx.select({ id: schema.outboxEvents.id }).from(schema.outboxEvents)
                .where(and(
                  eq(schema.outboxEvents.userId, inv.principalUserId),
                  eq(schema.outboxEvents.aggregateId, started.sessionId),
                ));
              if (!readBack || outbox.length === 0) throw new Error("training start read-back failed");
              return {
                response: {
                  trainingSessionId: readBack.id,
                  dayRole: started.dayRole,
                  exerciseCount: started.exerciseCount,
                },
                factRefs: [{ type: "training_session", id: readBack.id }],
                outboxEventIds: outbox.map((event) => event.id),
              };
            },
          );
          return complete(result.response);
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
        required: ["runHandle", "trainingSessionId", "sessionExerciseId", "setNumber", "idempotencyKey"],
      },
      execute: async (inv) => {
        const sessionId = str(inv.args, "trainingSessionId");
        const result = await writes.execute(
          writeInput(inv, "health_record_set", sessionId),
          async (tx) => {
            const recorded = await createTrainingService(tx as unknown as Db).recordSet({
              userId: inv.principalUserId,
              sessionId,
              sessionExerciseId: str(inv.args, "sessionExerciseId"),
              setNumber: optNum(inv.args, "setNumber") ?? 1,
              loadValue: optNum(inv.args, "loadValue") ?? null,
              loadUnit: (optStr(inv.args, "loadUnit") as "kg" | "lb" | "bodyweight" | undefined) ?? null,
              reps: optNum(inv.args, "reps") ?? null,
              rir: optNum(inv.args, "rir") ?? null,
              idempotencyKey: str(inv.args, "idempotencyKey"),
              source: `mcp:${inv.actor}`,
            });
            const [readBack] = await tx.select({
              id: schema.trainingSetLogs.id,
              sessionId: schema.trainingSessions.id,
            }).from(schema.trainingSetLogs)
              .innerJoin(
                schema.trainingSessionExercises,
                eq(schema.trainingSetLogs.sessionExerciseId, schema.trainingSessionExercises.id),
              )
              .innerJoin(
                schema.trainingSessions,
                eq(schema.trainingSessionExercises.sessionId, schema.trainingSessions.id),
              )
              .where(and(
                eq(schema.trainingSetLogs.id, recorded.log.id),
                eq(schema.trainingSessions.id, sessionId),
                eq(schema.trainingSessions.userId, inv.principalUserId),
              )).limit(1);
            const outbox = await tx.select({ id: schema.outboxEvents.id }).from(schema.outboxEvents)
              .where(and(
                eq(schema.outboxEvents.userId, inv.principalUserId),
                eq(schema.outboxEvents.aggregateId, recorded.log.id),
              ));
            if (!readBack || outbox.length === 0) throw new Error("training set read-back failed");
            return {
              response: {
                setId: readBack.id,
                beforeRevision: recorded.beforeRevision,
                afterRevision: recorded.afterRevision,
                exerciseCompleted: recorded.exerciseCompleted,
              },
              factRefs: [{ type: "training_set", id: readBack.id }],
              outboxEventIds: outbox.map((event) => event.id),
            };
          },
        );
        return complete(result.response);
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
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "trainingSessionId", "idempotencyKey"],
      },
      execute: async (inv) => {
        const status = (optStr(inv.args, "finalStatus") ?? "completed") as "completed" | "interrupted" | "cancelled";
        const sessionId = str(inv.args, "trainingSessionId");
        const result = await writes.execute(
          writeInput(inv, "health_finish_training", sessionId),
          async (tx) => {
            const txDb = tx as unknown as Db;
            const session = await createTrainingService(txDb)
              .finishSession(inv.principalUserId, sessionId, status);
            let cycle: { cycleInstanceId: string; positionIndex: number } | null = null;
            if (status === "completed") {
              const { createCycleEngine } = await import("../../training/cycle-engine.js");
              cycle = await createCycleEngine(txDb).recordCycleOutcome({
                userId: inv.principalUserId,
                sessionId: session.id,
                outcome: "completed",
                onDate: session.sessionDate,
              });
            }
            const [readBack] = await tx.select().from(schema.trainingSessions)
              .where(and(
                eq(schema.trainingSessions.id, sessionId),
                eq(schema.trainingSessions.userId, inv.principalUserId),
              )).limit(1);
            const outbox = await tx.select({ id: schema.outboxEvents.id }).from(schema.outboxEvents)
              .where(and(
                eq(schema.outboxEvents.userId, inv.principalUserId),
                eq(schema.outboxEvents.aggregateId, sessionId),
              ));
            if (!readBack || outbox.length === 0) throw new Error("training finish read-back failed");
            return {
              response: { sessionId: readBack.id, status: readBack.status, cycle },
              factRefs: [
                { type: "training_session", id: readBack.id },
                ...(cycle ? [{ type: "training_cycle", id: cycle.cycleInstanceId }] : []),
              ],
              outboxEventIds: outbox.map((event) => event.id),
            };
          },
        );
        return complete(result.response);
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
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "trainingSessionId", "sessionExerciseId", "idempotencyKey"],
      },
      execute: async (inv) => {
        const sessionId = str(inv.args, "trainingSessionId");
        const exerciseId = str(inv.args, "sessionExerciseId");
        const result = await writes.execute(
          writeInput(inv, "health_propose_substitution", `${sessionId}:${exerciseId}`),
          async (tx) => {
            const proposal = await createSubstitutionEngine(tx as unknown as Db)
              .propose(inv.principalUserId, sessionId, exerciseId);
            const [session] = await tx.select().from(schema.trainingSessions)
              .where(and(
                eq(schema.trainingSessions.id, sessionId),
                eq(schema.trainingSessions.userId, inv.principalUserId),
              )).limit(1);
            const [saved] = await tx.select().from(schema.substitutionProposals)
              .where(and(
                eq(schema.substitutionProposals.id, proposal.substitutionProposalId),
                eq(schema.substitutionProposals.userId, inv.principalUserId),
              )).limit(1);
            if (!session || !saved) throw new Error("substitution proposal read-back failed");
            const [outbox] = await tx.insert(schema.outboxEvents).values({
              userId: inv.principalUserId,
              aggregateType: "training_substitution",
              aggregateId: saved.id,
              eventType: "training.substitution_proposed",
              payloadJson: { observedOn: session.sessionDate, sessionId, exerciseId },
            }).returning({ id: schema.outboxEvents.id });
            if (!outbox) throw new Error("substitution proposal outbox failed");
            return {
              response: proposal as unknown as Record<string, unknown>,
              factRefs: [{ type: "substitution_proposal", id: saved.id }],
              outboxEventIds: [outbox.id],
            };
          },
        );
        return complete(result.response);
      },
    },
    {
      name: "health_apply_substitution",
      description: "Apply a substitution by proposal id + chosen slug. Candidates with trade-offs are chosen by the user (MRTR when ambiguous).",
      risk: "state-change",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          substitutionProposalId: { type: "string" },
          chosenSlug: { type: "string" },
          reason: { type: "string" },
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "substitutionProposalId", "chosenSlug", "idempotencyKey"],
      },
      execute: async (inv) => {
        try {
          const proposalId = str(inv.args, "substitutionProposalId");
          const result = await writes.execute(
            writeInput(inv, "health_apply_substitution", proposalId),
            async (tx) => {
              const applied = await createSubstitutionEngine(tx as unknown as Db).apply({
                userId: inv.principalUserId,
                substitutionProposalId: proposalId,
                chosenSlug: str(inv.args, "chosenSlug"),
                reason: optStr(inv.args, "reason") ?? "mcp substitution",
              });
              const [replacement] = await tx.select({
                id: schema.trainingSessionExercises.id,
                sessionId: schema.trainingSessions.id,
              }).from(schema.trainingSessionExercises)
                .innerJoin(
                  schema.trainingSessions,
                  eq(schema.trainingSessionExercises.sessionId, schema.trainingSessions.id),
                )
                .where(and(
                  eq(schema.trainingSessionExercises.id, applied.replacementId),
                  eq(schema.trainingSessions.userId, inv.principalUserId),
                )).limit(1);
              const outbox = await tx.select({ id: schema.outboxEvents.id }).from(schema.outboxEvents)
                .where(and(
                  eq(schema.outboxEvents.userId, inv.principalUserId),
                  eq(schema.outboxEvents.aggregateId, applied.replacementId),
                ));
              if (!replacement || outbox.length === 0) throw new Error("substitution apply read-back failed");
              return {
                response: { replacementId: replacement.id, trainingSessionId: replacement.sessionId },
                factRefs: [{ type: "training_substitution", id: replacement.id }],
                outboxEventIds: outbox.map((event) => event.id),
              };
            },
          );
          return complete(result.response);
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
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "trainingSessionId", "idempotencyKey"],
      },
      execute: async (inv) => {
        const sessionId = str(inv.args, "trainingSessionId");
        const result = await writes.execute(
          writeInput(inv, "health_record_reflection", sessionId),
          async (tx) => {
            const recorded = await createReflectionEngine(tx as unknown as Db).record({
              userId: inv.principalUserId,
              sessionId,
              bestCueRefs: (inv.args["bestCueRefs"] as string[] | undefined) ?? [],
              unresolvedIssues: (inv.args["unresolvedIssues"] as Array<Record<string, unknown>> | undefined) ?? [],
              painSummary: (inv.args["painSummary"] as Array<Record<string, unknown>> | undefined) ?? [],
              proposedAdjustments: (inv.args["proposedAdjustments"] as never) ?? [],
              nextValidationQuestions: (inv.args["nextValidationQuestions"] as string[] | undefined) ?? [],
            });
            const [session] = await tx.select().from(schema.trainingSessions)
              .where(and(
                eq(schema.trainingSessions.id, sessionId),
                eq(schema.trainingSessions.userId, inv.principalUserId),
              )).limit(1);
            const [readBack] = await tx.select().from(schema.trainingReflections)
              .where(and(
                eq(schema.trainingReflections.id, recorded.reflectionId),
                eq(schema.trainingReflections.userId, inv.principalUserId),
              )).limit(1);
            if (!session || !readBack) throw new Error("reflection read-back failed");
            const [outbox] = await tx.insert(schema.outboxEvents).values({
              userId: inv.principalUserId,
              aggregateType: "training_reflection",
              aggregateId: readBack.id,
              eventType: "training.reflection_recorded",
              payloadJson: { observedOn: session.sessionDate, sessionId },
            }).returning({ id: schema.outboxEvents.id });
            if (!outbox) throw new Error("reflection outbox failed");
            return {
              response: { reflectionId: readBack.id },
              factRefs: [{ type: "training_reflection", id: readBack.id }],
              outboxEventIds: [outbox.id],
            };
          },
        );
        return complete(result.response);
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
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "reflectionId", "reason", "idempotencyKey"],
      },
      execute: async (inv) => {
        const reflectionId = str(inv.args, "reflectionId");
        const result = await writes.execute(
          writeInput(inv, "health_propose_plan_change", reflectionId),
          async (tx) => {
            const proposed = await createReflectionEngine(tx as unknown as Db).proposeChildVersion({
              userId: inv.principalUserId,
              reflectionId,
              changes: (inv.args["changes"] as Array<Record<string, unknown>> | undefined) ?? [],
              reason: str(inv.args, "reason"),
            });
            const [readBack] = await tx.select().from(schema.planVersions)
              .where(and(
                eq(schema.planVersions.id, proposed.childVersionId),
                eq(schema.planVersions.userId, inv.principalUserId),
              )).limit(1);
            if (!readBack) throw new Error("plan proposal read-back failed");
            const [outbox] = await tx.insert(schema.outboxEvents).values({
              userId: inv.principalUserId,
              aggregateType: "plan_version",
              aggregateId: readBack.id,
              eventType: "plan.version_proposed",
              payloadJson: { observedOn: today(), reflectionId },
            }).returning({ id: schema.outboxEvents.id });
            if (!outbox) throw new Error("plan proposal outbox failed");
            return {
              response: proposed,
              factRefs: [{ type: "plan_version", id: readBack.id }],
              outboxEventIds: [outbox.id],
            };
          },
        );
        return complete(result.response);
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
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "planVersionId", "idempotencyKey"],
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

        if (inv.requestState === undefined) {
          const parent = version.parentVersionId
            ? (await db.select().from(schema.planVersions)
                .where(eq(schema.planVersions.id, version.parentVersionId)).limit(1))[0]
            : undefined;
          return await makeConfirmation(
            "health_activate_plan_version", planVersionId, inv,
            `激活将把当前训练计划切换到 v${version.versionNumber}（原因：${version.adjustmentReason ?? "n/a"}），父版本 ${parent?.versionNumber ?? "?"} 转为 superseded，可回滚。确认激活？`,
            ["确认激活", "暂不激活"],
            { planVersionId },
          );
        }
        const result = await requestStates.consume(
          inv.requestState,
          pendingBinding("health_activate_plan_version", planVersionId, inv),
          async (tx) => {
            return writes.executeInTransaction(
              tx,
              writeInput(inv, "health_activate_plan_version", planVersionId),
              async (writeTx) => {
                const confirmed = inv.confirmationChoice === "确认激活";
                if (confirmed) {
                  await createReflectionEngine(writeTx as unknown as Db)
                    .activateChildVersion(inv.principalUserId, planVersionId);
                }
                const [decision] = await writeTx.insert(schema.userDecisionEvents).values({
                  userId: inv.principalUserId,
                  decisionType: confirmed ? "accepted" : "rejected",
                  subjectJson: { type: "plan_activation", planVersionId },
                }).returning();
                if (!decision) throw new Error("plan activation decision insert failed");
                const [outbox] = await writeTx.insert(schema.outboxEvents).values({
                  userId: inv.principalUserId,
                  aggregateType: confirmed ? "plan_version" : "user_decision",
                  aggregateId: confirmed ? planVersionId : decision.id,
                  eventType: confirmed ? "plan.version_activated" : "plan.activation_declined",
                  payloadJson: { observedOn: today(), planVersionId },
                }).returning({ id: schema.outboxEvents.id });
                const [readBack] = await writeTx.select().from(schema.planVersions)
                  .where(and(
                    eq(schema.planVersions.id, planVersionId),
                    eq(schema.planVersions.userId, inv.principalUserId),
                  )).limit(1);
                if (!outbox || !readBack) throw new Error("plan activation read-back failed");
                return {
                  response: confirmed
                    ? { planVersionId, activated: true, status: readBack.status }
                    : { planVersionId, activated: false, declined: true },
                  factRefs: confirmed
                    ? [{ type: "plan_version", id: readBack.id }, { type: "user_decision", id: decision.id }]
                    : [{ type: "user_decision", id: decision.id }],
                  outboxEventIds: [outbox.id],
                };
              },
            );
          },
        );
        return complete(result.response);
      },
    },
  ];

  if (options.conformanceProfile) {
    toolDefs.push({
      name: "test_missing_capability",
      description: "Official conformance diagnostic for missing sampling capability.",
      risk: "read-only",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({
        resultType: "input_required",
        content: [],
        structured: {
          inputRequests: {
            sample: {
              method: "sampling/createMessage",
              params: {
                messages: [{ role: "user", content: { type: "text", text: "conformance" } }],
                maxTokens: 1,
              },
            },
          },
        },
      }),
    });
    toolDefs.push({
      name: "test_input_required_result_request_state",
      description: "Official conformance diagnostic for MCP requestState round trips.",
      risk: "read-only",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: async (inv) => {
        if (inv.requestState === undefined) {
          return {
            resultType: "input_required",
            content: [],
            structured: {
              inputRequests: {
                confirm: {
                  method: "elicitation/create",
                  params: {
                    mode: "form",
                    message: "Please confirm",
                    requestedSchema: {
                      type: "object",
                      properties: { ok: { type: "boolean" } },
                      required: ["ok"],
                    },
                  },
                },
              },
              requestState: "conformance-state-v1",
            },
          };
        }
        const confirmed = (inv.inputResponses?.confirm as {
          action?: unknown;
          content?: { ok?: unknown };
        } | undefined);
        if (inv.requestState !== "conformance-state-v1"
            || confirmed?.action !== "accept"
            || confirmed.content?.ok !== true) {
          return toolError("validation_failed", "conformance requestState or response mismatch");
        }
        return complete({ status: "state-ok" });
      },
    });
  }

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
        if (error instanceof RequestStateError) {
          return toolError("proposal_stale", error.message);
        }
        if (error instanceof CandidateSelectionError) {
          return toolError("proposal_stale", error.message);
        }
        if (error instanceof WriteCommandError) {
          return toolError(error.code, error.message);
        }
        return toolError("internal", "internal error");
      }
    },
  };
}
