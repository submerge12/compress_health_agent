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

type Db = PostgresJsDatabase<typeof schema>;

export class RunHandleError extends Error {
  readonly code = "run_handle_invalid";
  constructor(readonly reason: string) {
    super(`run handle invalid: ${reason}`);
  }
}

/** Redact tool arguments before persisting them as evidence. */
export function redactArguments(args: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!args) return {};
  const REDACT_KEYS = new Set([
    "token", "password", "secret", "apiKey", "api_key", "authorization",
    "description", "notes", "reason", "objective", "responseSummary",
  ]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (REDACT_KEYS.has(key)) {
      out[key] = typeof value === "string" ? `<redacted:${value.length}>` : "<redacted>";
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redactArguments(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function createRunHandleService(db: Db) {
  /**
   * Begin a run. The actor label is recorded for attribution; authorization
   * was already resolved from the transport binding.
   */
  async function beginRun(input: {
    userId: string;
    objective: string;
    inputChannel?: string;
    actor?: string;
    mode?: "production" | "shadow" | "limited_write" | "review";
    parentRunId?: string;
  }): Promise<{
    runHandle: string;
    journeyId: string;
    actor: string;
    stateRevision: number;
  }> {
    const journeyId = `journey_${crypto.randomUUID()}`;
    const [run] = await db.insert(schema.agentRuns).values({
      userId: input.userId,
      journeyId,
      objective: input.objective.slice(0, 500),
      inputChannel: input.inputChannel ?? "mcp",
      mode: input.mode ?? "production",
      outcome: "running",
      parentRunId: input.parentRunId ?? null,
    }).returning();
    if (!run) throw new Error("agent run insert returned no row");

    await db.insert(schema.agentRunSteps).values({
      runId: run.id,
      sequence: 0,
      stage: "response",
      mcpMethod: "tools/call",
      mcpName: "health_begin_run",
      status: "ok",
      resultSummaryJson: { objective: `<redacted:${input.objective.length}>`, channel: input.inputChannel ?? "mcp" },
    });

    const stateRevision = await latestRevision(db, input.userId);
    return { runHandle: run.id, journeyId, actor: input.actor ?? "codex-primary", stateRevision };
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
          ...(input.responseSummary !== undefined
            ? { responseSummary: input.responseSummary.slice(0, 1000) } : {}),
        })
        .where(and(eq(schema.agentRuns.id, run.id), eq(schema.agentRuns.outcome, "running")))
        .returning({ id: schema.agentRuns.id });
      if (updated.length === 0) return; // concurrent endRun won; keep first

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

      await tx.insert(schema.outboxEvents).values({
        userId: input.userId,
        aggregateType: "user_decision",
        aggregateId: run.id,
        eventType: "agent.run_ended",
        payloadJson: { outcome: input.outcome, journeyId: run.journeyId },
      });
    });

    return { runHandle: run.id, outcome: input.outcome, stepCount: await countSteps(db, run.id) };
  }

  /** Record one observable step (resource read, tool call, confirmation). */
  async function recordStep(input: {
    userId: string;
    runHandle: string;
    stage: "resource_read" | "tool_call" | "confirmation" | "response";
    mcpMethod?: string;
    mcpName?: string;
    resourceUri?: string;
    aggregateType?: string;
    aggregateId?: string;
    stateRevisionBefore?: number;
    stateRevisionAfter?: number;
    status?: "ok" | "failed" | "refused";
    errorCode?: string;
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
      if (run.outcome !== "running") throw new RunHandleError("closed");
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
        argumentsRedactedJson: redactArguments(input.arguments),
        resultSummaryJson: input.resultSummary ?? null,
      });
      return { sequence };
    });
  }

  async function getRun(userId: string, runHandle: string) {
    const run = await requireOwnedRun(db, userId, runHandle);
    const [steps, receipts] = await Promise.all([
      db.select().from(schema.agentRunSteps)
        .where(eq(schema.agentRunSteps.runId, run.id))
        .orderBy(schema.agentRunSteps.sequence),
      db.select().from(schema.mcpWriteReceipts)
        .where(eq(schema.mcpWriteReceipts.runId, run.id))
        .orderBy(schema.mcpWriteReceipts.createdAt),
    ]);
    return {
      run: {
        runHandle: run.id,
        journeyId: run.journeyId,
        objective: run.objective,
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
        aggregateType: s.aggregateType,
        aggregateId: s.aggregateId,
        stateRevisionBefore: s.stateRevisionBefore,
        stateRevisionAfter: s.stateRevisionAfter,
        argumentsRedacted: s.argumentsRedactedJson ?? {},
        resultSummary: s.resultSummaryJson,
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


