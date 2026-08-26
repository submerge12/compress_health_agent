/**
 * P3 / WO-MCP-3: run handles.
 *
 * Every formal health journey starts with health_begin_run and ends with
 * health_end_run. Write tools REQUIRE a runHandle; read tools may run
 * handle-less (they still record an independent trace step). Steps capture
 * the observable evidence chain — resource reads, tool calls, confirmations —
 * with redacted arguments only.
 *
 * Handles are plain UUIDs of agent_runs rows: stateless servers, durable
 * state, exactly the 2026-07-28 model (no hidden session).
 */
import { and, eq, sql } from "drizzle-orm";

import * as schema from "../../db/schema.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { resolveActor, type ActorProfileInput } from "../auth/actor-registry.js";
import {
  redactEvidenceRecord,
  redactEvidenceValue,
  SENSITIVE_RETENTION_POLICY,
} from "./privacy-policy.js";
import {
  createSensitivePayloadService,
  type SensitivePayloadServiceOptions,
} from "./sensitive-payloads.js";

type Db = PostgresJsDatabase<typeof schema>;

export class RunHandleError extends Error {
  readonly code = "run_handle_invalid";
  constructor(readonly reason: string) {
    super(`run handle invalid: ${reason}`);
  }
}

export { redactEvidenceValue };

/** Redact tool arguments before persisting them as evidence. */
export function redactArguments(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return redactEvidenceRecord(args);
}

export function createRunHandleService(
  db: Db,
  options: { sensitivePayloads?: SensitivePayloadServiceOptions } = {},
) {
  /**
   * Begin a run. The actor label is recorded for attribution; authorization
   * was already resolved from the transport binding.
   */
  async function beginRun(input: {
    userId: string;
    objective: string;
    inputChannel?: string;
    actor?: string;
    actorId?: string;
    actorProfile?: ActorProfileInput;
    mode?: "production" | "shadow" | "limited_write" | "review";
    parentRunId?: string;
  }): Promise<{
    runHandle: string;
    journeyId: string;
    actor: string;
    stateRevision: number;
  }> {
    return db.transaction(async (tx) => {
      const transactionDb = tx as unknown as Db;
      const actor = await resolveActor(transactionDb, {
        actor: input.actor,
        ...(input.actorProfile ? { actorProfile: input.actorProfile } : {}),
      });
      if (input.actorId !== undefined && input.actorId !== actor.id) {
        throw new RunHandleError("actor_mismatch");
      }
      const objective = await createSensitivePayloadService(
        transactionDb,
        options.sensitivePayloads,
      ).protectText({
        userId: input.userId,
        payloadType: "agent_objective",
        plaintext: input.objective.slice(0, 500),
        retentionDays: SENSITIVE_RETENTION_POLICY.agentObjective.days,
      });
      const journeyId = `journey_${crypto.randomUUID()}`;
      const [run] = await tx.insert(schema.agentRuns).values({
        userId: input.userId,
        actorId: actor.id,
        journeyId,
        objective: objective.evidenceText.slice(0, 500),
        objectivePayloadId: objective.payloadId,
        inputChannel: input.inputChannel ?? "mcp",
        mode: input.mode ?? "production",
        outcome: "running",
        parentRunId: input.parentRunId ?? null,
      }).returning();
      if (!run) throw new Error("agent run insert returned no row");

      await tx.insert(schema.interactionEvents).values({
        userId: input.userId,
        requestId: run.id,
        journeyId,
        actor: `mcp:${actor.verifiedActor}`,
        stage: "agent_run",
        stageCode: "started",
        detailJson: { runId: run.id, inputChannel: input.inputChannel ?? "mcp" },
      });

      await tx.insert(schema.agentRunSteps).values({
        runId: run.id,
        sequence: 0,
        stage: "response",
        mcpMethod: "tools/call",
        mcpName: "health_begin_run",
        status: "ok",
        resultSummaryJson: { objective: objective.evidenceText, channel: input.inputChannel ?? "mcp" },
      });

      const stateRevision = await latestRevision(transactionDb, input.userId);
      return { runHandle: run.id, journeyId, actor: actor.verifiedActor, stateRevision };
    });
  }

  /**
   * End a run: outcome + optional summary + the user's acceptance signal.
   * Idempotent — ending twice keeps the FIRST terminal outcome.
   */
  async function endRun(input: {
    userId: string;
    runHandle: string;
    outcome: "completed" | "failed" | "abandoned";
    responseSummary?: string;
    userAccepted?: boolean;
    observedOn?: string;
  }): Promise<{ runHandle: string; outcome: string; stepCount: number }> {
    const run = await requireOwnedRun(db, input.userId, input.runHandle);
    if (run.outcome !== "running") {
      return { runHandle: run.id, outcome: run.outcome, stepCount: await countSteps(db, run.id) };
    }

    await db.transaction(async (tx) => {
      const updated = await tx.update(schema.agentRuns)
        .set({
          outcome: input.outcome,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(schema.agentRuns.id, run.id), eq(schema.agentRuns.outcome, "running")))
        .returning({ id: schema.agentRuns.id });
      if (updated.length === 0) return; // concurrent endRun won; keep first

      if (input.responseSummary !== undefined) {
        const responseSummary = await createSensitivePayloadService(
          tx as unknown as Db,
          options.sensitivePayloads,
        ).protectText({
          userId: input.userId,
          payloadType: "agent_response_summary",
          plaintext: input.responseSummary.slice(0, 1000),
          retentionDays: SENSITIVE_RETENTION_POLICY.agentResponseSummary.days,
        });
        await tx.update(schema.agentRuns).set({
          responseSummary: responseSummary.evidenceText.slice(0, 1000),
          responseSummaryPayloadId: responseSummary.payloadId,
          updatedAt: new Date(),
        }).where(eq(schema.agentRuns.id, run.id));
      }

      await tx.insert(schema.agentRunSteps).values({
        runId: run.id,
        sequence: await nextSequence(tx, run.id),
        stage: "response",
        mcpMethod: "tools/call",
        mcpName: "health_end_run",
        status: input.outcome === "completed" ? "ok" : "failed",
        resultSummaryJson: {
          outcome: input.outcome,
          userAccepted: input.userAccepted ?? null,
        },
      });

      await tx.insert(schema.interactionEvents).values({
        userId: input.userId,
        requestId: run.id,
        journeyId: run.journeyId,
        actor: "mcp:run-service",
        stage: "agent_run",
        stageCode: "ended",
        detailJson: { runId: run.id, outcome: input.outcome },
      });
      if (input.userAccepted !== undefined) {
        const [decision] = await tx.insert(schema.userDecisionEvents).values({
          userId: input.userId,
          decisionType: input.userAccepted ? "accepted" : "rejected",
          subjectJson: {
            type: "agent_run_outcome",
            runId: run.id,
            accepted: input.userAccepted,
            outcome: input.outcome,
          },
          journeyId: run.journeyId,
        }).returning({ id: schema.userDecisionEvents.id });
        if (!decision) throw new Error("run outcome decision insert returned no row");
        await tx.insert(schema.outboxEvents).values({
          userId: input.userId,
          aggregateType: "user_decision",
          aggregateId: decision.id,
          eventType: "user.decision_recorded",
          payloadJson: {
            observedOn: input.observedOn ?? new Date().toISOString().slice(0, 10),
            type: "agent_run_outcome",
            runId: run.id,
          },
        });
      }
    });

    return { runHandle: run.id, outcome: input.outcome, stepCount: await countSteps(db, run.id) };
  }

  /** Record one observable step (resource read, tool call, confirmation). */
  async function recordStep(input: {
    userId: string;
    runHandle: string;
    stage: "resource_read" | "tool_attempt" | "tool_result" | "tool_commit" | "tool_call" | "confirmation" | "response";
    mcpMethod?: string;
    mcpName?: string;
    resourceUri?: string;
    aggregateType?: string;
    aggregateId?: string;
    stateRevisionBefore?: number;
    stateRevisionAfter?: number;
    status?: "ok" | "failed" | "refused" | "input_required";
    errorCode?: string;
    failureStage?: string;
    actorId?: string;
    /** Only dispatch may append health_end_run's terminal result after close. */
    allowClosed?: boolean;
    arguments?: Record<string, unknown>;
    resultSummary?: Record<string, unknown>;
  }): Promise<{ sequence: number }> {
    return db.transaction(async (tx) => {
      // The run row is the sequence allocator. Locking it serializes resource
      // reads with write-command evidence and with run closure across every
      // process, without relying on an in-memory counter.
      const [run] = await tx.select().from(schema.agentRuns)
        .where(and(
          eq(schema.agentRuns.id, input.runHandle),
          eq(schema.agentRuns.userId, input.userId),
        ))
        .limit(1)
        .for("update");
      if (!run) throw new RunHandleError("not_found_or_not_owned");
      if (input.actorId !== undefined && run.actorId !== input.actorId) {
        throw new RunHandleError("actor_mismatch");
      }
      if (run.outcome !== "running" && input.allowClosed !== true) throw new RunHandleError("closed");
      const sequence = await nextSequence(tx, run.id);
      await tx.insert(schema.agentRunSteps).values({
        runId: run.id,
        sequence,
        stage: input.stage,
        mcpMethod: input.mcpMethod ?? null,
        mcpName: input.mcpName ?? null,
        resourceUri: input.resourceUri ?? null,
        aggregateType: input.aggregateType ?? null,
        aggregateId: input.aggregateId ?? null,
        stateRevisionBefore: input.stateRevisionBefore ?? null,
        stateRevisionAfter: input.stateRevisionAfter ?? null,
        status: input.status ?? "ok",
        errorCode: input.errorCode ?? null,
        failureStage: input.failureStage ?? null,
        argumentsRedactedJson: redactArguments(input.arguments),
        resultSummaryJson: input.resultSummary === undefined
          ? null
          : redactArguments(input.resultSummary),
      });
      return { sequence };
    });
  }

  async function getRun(userId: string, runHandle: string, actorId?: string) {
    const run = await requireOwnedRun(db, userId, runHandle);
    if (actorId !== undefined && run.actorId !== actorId) throw new RunHandleError("actor_mismatch");
    const [actor, steps, receipts] = await Promise.all([
      db.select().from(schema.agentActors)
        .where(eq(schema.agentActors.id, run.actorId))
        .limit(1)
        .then((rows) => rows[0]),
      db.select().from(schema.agentRunSteps)
        .where(eq(schema.agentRunSteps.runId, run.id))
        .orderBy(schema.agentRunSteps.sequence),
      db.select().from(schema.mcpWriteReceipts)
        .where(eq(schema.mcpWriteReceipts.runId, run.id))
        .orderBy(schema.mcpWriteReceipts.createdAt),
    ]);
    if (!actor) throw new Error("run actor profile is missing");
    return {
      actor: {
        id: actor.id,
        actorType: actor.actorType,
        runtimeName: actor.runtimeName,
        runtimeVersion: actor.runtimeVersion,
        agentProfile: actor.agentProfile,
        agentProfileVersion: actor.agentProfileVersion,
        modelProvider: actor.modelProvider,
        modelName: actor.modelName,
        status: actor.status,
      },
      run: {
        runHandle: run.id,
        journeyId: run.journeyId,
        objective: run.objective,
        objectivePayloadRef: run.objectivePayloadId,
        responseSummary: run.responseSummary,
        responseSummaryPayloadRef: run.responseSummaryPayloadId,
        mode: run.mode,
        inputChannel: run.inputChannel,
        outcome: run.outcome,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      },
      steps: steps.map((s) => ({
        sequence: s.sequence,
        stage: s.stage,
        mcpMethod: s.mcpMethod,
        mcpName: s.mcpName,
        resourceUri: s.resourceUri,
        status: s.status,
        errorCode: s.errorCode,
        failureStage: s.failureStage,
        aggregateType: s.aggregateType,
        aggregateId: s.aggregateId,
        stateRevisionBefore: s.stateRevisionBefore,
        stateRevisionAfter: s.stateRevisionAfter,
        // Re-apply current policy on read so legacy rows written before a new
        // sensitive-key rule cannot leak through evidence retrieval.
        argumentsRedacted: redactArguments(s.argumentsRedactedJson ?? {}),
        resultSummary: s.resultSummaryJson === null
          ? null
          : redactArguments(s.resultSummaryJson),
      })),
      receipts: receipts.map((receipt) => ({
        receiptId: receipt.id,
        toolName: receipt.toolName,
        scopeKey: receipt.scopeKey,
        factRefs: receipt.factRefsJson,
        outboxEventIds: receipt.outboxEventIdsJson,
        createdAt: receipt.createdAt,
      })),
    };
  }

  return { beginRun, endRun, recordStep, getRun };
}

async function requireOwnedRun(db: Db, userId: string, runHandle: string) {
  const [run] = await db.select().from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.id, runHandle), eq(schema.agentRuns.userId, userId)))
    .limit(1);
  if (!run) throw new RunHandleError("not_found_or_not_owned");
  return run;
}

async function nextSequence(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  runId: string,
): Promise<number> {
  // Caller must hold the matching agent_runs row FOR UPDATE.
  const [row] = await tx.select({ max: sql<number>`coalesce(max(${schema.agentRunSteps.sequence}), -1)::int` })
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, runId));
  return (row?.max ?? -1) + 1;
}

async function countSteps(db: Db, runId: string): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` })
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, runId));
  return row?.n ?? 0;
}

async function latestRevision(db: Db, userId: string): Promise<number> {
  const [row] = await db.select({ max: sql<number>`coalesce(max(${schema.dailyHealthStateProjection.revision}), 0)::int` })
    .from(schema.dailyHealthStateProjection)
    .where(eq(schema.dailyHealthStateProjection.userId, userId));
  return row?.max ?? 0;
}


