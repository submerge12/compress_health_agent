import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../../db/schema.js";
import { hashArguments, type HealthTransaction } from "../input/request-state.js";
import { redactArguments } from "../evidence/run-handles.js";
import { resolveActor, type ActorProfileInput } from "../auth/actor-registry.js";

type Db = PostgresJsDatabase<typeof schema>;

export class WriteCommandError extends Error {
  constructor(readonly code: "run_handle_invalid" | "idempotency_conflict" | "actor_mismatch" | "write_contract_failed", message: string) {
    super(message);
  }
}

export interface WriteMutation {
  response: Record<string, unknown>;
  factRefs: Array<{ type: string; id: string }>;
  outboxEventIds: string[];
  /** Operational maintenance writes audit here instead of re-entering health projection. */
  auditEventIds?: string[];
}

export interface WriteCommandInput {
  userId: string;
  verifiedActor: string;
  actorId?: string;
  actorProfile?: ActorProfileInput;
  runHandle: string;
  toolName: string;
  scopeKey: string;
  idempotencyKey: string;
  arguments: Record<string, unknown>;
}

export interface WriteCommandResult {
  response: Record<string, unknown>;
  replayed: boolean;
  receiptId: string;
}

export interface BeginRunInput {
  userId: string;
  verifiedActor: string;
  actorId?: string;
  actorProfile?: ActorProfileInput;
  idempotencyKey: string;
  objective: string;
  inputChannel: string;
  arguments: Record<string, unknown>;
}

/**
 * The write interface used by every MCP mutation.
 *
 * The callback inserts domain facts and outbox rows on the supplied
 * transaction. This module then performs read-back, records run evidence,
 * and writes the idempotency receipt before the same transaction commits.
 */
export function createWriteCommandService(db: Db) {
  async function beginRun(input: BeginRunInput): Promise<WriteCommandResult> {
    const argumentHash = hashArguments(input.arguments);
    return db.transaction(async (tx) => {
      const actor = await resolveCommandActor(tx as unknown as Db, input);
      const [ownedUser] = await tx.select({ id: schema.users.id }).from(schema.users)
        .where(eq(schema.users.id, input.userId))
        .limit(1)
        .for("update");
      if (!ownedUser) throw new WriteCommandError("write_contract_failed", "verified user vanished");
      const [existing] = await tx.select().from(schema.mcpWriteReceipts)
        .where(and(
          eq(schema.mcpWriteReceipts.userId, input.userId),
          eq(schema.mcpWriteReceipts.toolName, "health_begin_run"),
          eq(schema.mcpWriteReceipts.scopeKey, "run-bootstrap"),
          eq(schema.mcpWriteReceipts.idempotencyKey, input.idempotencyKey),
        )).limit(1);
      if (existing) {
        if (existing.argumentHash !== argumentHash) {
          throw new WriteCommandError("idempotency_conflict", "begin-run key has different arguments");
        }
        const [existingRun] = await tx.select({ actorId: schema.agentRuns.actorId })
          .from(schema.agentRuns)
          .where(and(
            eq(schema.agentRuns.id, existing.runId),
            eq(schema.agentRuns.userId, input.userId),
          ))
          .limit(1);
        if (
          existing.verifiedActor !== input.verifiedActor
          || existingRun?.actorId !== actor.id
        ) {
          throw new WriteCommandError("actor_mismatch", "begin-run receipt belongs to another verified actor");
        }
        return {
          response: { ...existing.responseJson, replayed: true },
          replayed: true,
          receiptId: existing.id,
        };
      }

      const journeyId = `journey_${crypto.randomUUID()}`;
      const [run] = await tx.insert(schema.agentRuns).values({
        userId: input.userId,
        actorId: actor.id,
        journeyId,
        objective: input.objective.slice(0, 500),
        inputChannel: input.inputChannel,
        mode: "production",
        outcome: "running",
      }).returning();
      if (!run) throw new Error("agent run insert returned no row");
      const [audit] = await tx.insert(schema.interactionEvents).values({
        userId: input.userId,
        requestId: run.id,
        journeyId,
        actor: `mcp:${input.verifiedActor}`,
        stage: "agent_run",
        stageCode: "started",
        detailJson: { runId: run.id, inputChannel: input.inputChannel },
      }).returning({ id: schema.interactionEvents.id });
      if (!audit) throw new Error("run start audit insert returned no row");
      const [revision] = await tx.select({
        value: sql<number>`coalesce(max(${schema.dailyHealthStateProjection.revision}), 0)::int`,
      }).from(schema.dailyHealthStateProjection)
        .where(eq(schema.dailyHealthStateProjection.userId, input.userId));
      const receiptId = crypto.randomUUID();
      const response = {
        runHandle: run.id,
        journeyId,
        actor: input.verifiedActor,
        stateRevision: revision?.value ?? 0,
        receiptId,
        replayed: false,
      };
      await tx.insert(schema.mcpWriteReceipts).values({
        id: receiptId,
        userId: input.userId,
        runId: run.id,
        verifiedActor: input.verifiedActor,
        toolName: "health_begin_run",
        scopeKey: "run-bootstrap",
        idempotencyKey: input.idempotencyKey,
        argumentHash,
        factRefsJson: [{ type: "agent_run", id: run.id }],
        outboxEventIdsJson: [],
        responseJson: response,
      });
      const [storedReceipt] = await tx.select().from(schema.mcpWriteReceipts).where(and(
        eq(schema.mcpWriteReceipts.id, receiptId),
        eq(schema.mcpWriteReceipts.userId, input.userId),
        eq(schema.mcpWriteReceipts.runId, run.id),
      )).limit(1);
      if (!storedReceipt) throw new WriteCommandError("write_contract_failed", "begin-run receipt read-back failed");
      await tx.insert(schema.agentRunSteps).values([
        {
          runId: run.id,
          sequence: 0,
          stage: "tool_attempt",
          mcpMethod: "tools/call",
          mcpName: "health_begin_run",
          status: "ok",
          argumentsRedactedJson: redactArguments(input.arguments),
        },
        {
          runId: run.id,
          sequence: 1,
          stage: "tool_result",
          mcpMethod: "tools/call",
          mcpName: "health_begin_run",
          status: "ok",
          resultSummaryJson: { resultType: "complete", receiptId, auditEventId: audit.id },
        },
      ]);
      return { response: storedReceipt.responseJson, replayed: false, receiptId };
    });
  }

  async function execute(
    input: WriteCommandInput,
    mutate: (tx: HealthTransaction) => Promise<WriteMutation>,
  ): Promise<WriteCommandResult> {
    if (!input.idempotencyKey.trim()) {
      throw new WriteCommandError("write_contract_failed", "idempotencyKey is required");
    }
    return db.transaction((tx) => executeInTransaction(tx, input, mutate));
  }

  async function executeInTransaction(
    tx: HealthTransaction,
    input: WriteCommandInput,
    mutate: (tx: HealthTransaction) => Promise<WriteMutation>,
  ): Promise<WriteCommandResult> {
    if (!input.idempotencyKey.trim()) {
      throw new WriteCommandError("write_contract_failed", "idempotencyKey is required");
    }
    const argumentHash = hashArguments(input.arguments);
    const actor = await resolveCommandActor(tx as unknown as Db, input);
    const [run] = await tx.select().from(schema.agentRuns)
      .where(and(
        eq(schema.agentRuns.id, input.runHandle),
        eq(schema.agentRuns.userId, input.userId),
      ))
      .limit(1)
      .for("update");
    if (!run) {
      throw new WriteCommandError("run_handle_invalid", "run is missing or foreign");
    }
    if (run.actorId !== actor.id) {
      throw new WriteCommandError("actor_mismatch", "run belongs to another verified actor");
    }

    const [existing] = await tx.select().from(schema.mcpWriteReceipts)
      .where(and(
        eq(schema.mcpWriteReceipts.userId, input.userId),
        eq(schema.mcpWriteReceipts.toolName, input.toolName),
        eq(schema.mcpWriteReceipts.scopeKey, input.scopeKey),
        eq(schema.mcpWriteReceipts.idempotencyKey, input.idempotencyKey),
      ))
      .limit(1);
    if (existing) {
      if (existing.argumentHash !== argumentHash || existing.runId !== input.runHandle) {
        throw new WriteCommandError(
          "idempotency_conflict",
          "idempotency key was already used for different arguments or run",
        );
      }
      if (existing.verifiedActor !== input.verifiedActor) {
        throw new WriteCommandError("actor_mismatch", "receipt belongs to another verified actor");
      }
      return {
        response: { ...existing.responseJson, replayed: true },
        replayed: true,
        receiptId: existing.id,
      };
    }
    if (run.outcome !== "running") {
      throw new WriteCommandError("run_handle_invalid", "run is already closed");
    }

    const mutation = await mutate(tx);
    const auditEventIds = mutation.auditEventIds ?? [];
    if (
      mutation.factRefs.length === 0
      || (mutation.outboxEventIds.length === 0 && auditEventIds.length === 0)
    ) {
      throw new WriteCommandError(
        "write_contract_failed",
        "write must return at least one fact and one outbox or operational audit event",
      );
    }

    const receiptId = crypto.randomUUID();
    const response = { ...mutation.response, receiptId, replayed: false };
    await tx.insert(schema.mcpWriteReceipts).values({
      id: receiptId,
      userId: input.userId,
      runId: input.runHandle,
      verifiedActor: input.verifiedActor,
      toolName: input.toolName,
      scopeKey: input.scopeKey,
      idempotencyKey: input.idempotencyKey,
      argumentHash,
      factRefsJson: mutation.factRefs,
      outboxEventIdsJson: mutation.outboxEventIds,
      responseJson: response,
    });
    if (mutation.outboxEventIds.length > 0) {
      const outboxReadBack = await tx.select({ id: schema.outboxEvents.id })
        .from(schema.outboxEvents)
        .where(inArray(schema.outboxEvents.id, mutation.outboxEventIds));
      if (outboxReadBack.length !== mutation.outboxEventIds.length) {
        throw new WriteCommandError("write_contract_failed", "outbox read-back did not match mutation");
      }
    }
    if (auditEventIds.length > 0) {
      const auditReadBack = await tx.select({ id: schema.interactionEvents.id })
        .from(schema.interactionEvents)
        .where(and(
          inArray(schema.interactionEvents.id, auditEventIds),
          eq(schema.interactionEvents.userId, input.userId),
        ));
      if (auditReadBack.length !== auditEventIds.length) {
        throw new WriteCommandError("write_contract_failed", "audit read-back did not match mutation");
      }
    }
    const [storedReceipt] = await tx.select().from(schema.mcpWriteReceipts).where(and(
      eq(schema.mcpWriteReceipts.id, receiptId),
      eq(schema.mcpWriteReceipts.userId, input.userId),
      eq(schema.mcpWriteReceipts.runId, input.runHandle),
    )).limit(1);
    if (!storedReceipt) throw new WriteCommandError("write_contract_failed", "write receipt read-back failed");

    const [sequenceRow] = await tx.select({
      max: sql<number>`coalesce(max(${schema.agentRunSteps.sequence}), -1)::int`,
    }).from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, input.runHandle));
    await tx.insert(schema.agentRunSteps).values({
      runId: input.runHandle,
      sequence: (sequenceRow?.max ?? -1) + 1,
      stage: "tool_commit",
      mcpMethod: "tools/call",
      mcpName: input.toolName,
      status: "ok",
      argumentsRedactedJson: redactArguments(input.arguments),
      resultSummaryJson: {
        receiptId,
        facts: mutation.factRefs,
        outboxEventIds: mutation.outboxEventIds,
        auditEventIds,
      },
    });

    return { response: storedReceipt.responseJson, replayed: false, receiptId };
  }

  return { beginRun, execute, executeInTransaction };
}

async function resolveCommandActor(
  db: Db,
  input: { verifiedActor: string; actorId?: string; actorProfile?: ActorProfileInput },
) {
  const actor = await resolveActor(db, {
    actor: input.verifiedActor,
    ...(input.actorProfile ? { actorProfile: input.actorProfile } : {}),
  });
  if (input.actorId !== undefined && input.actorId !== actor.id) {
    throw new WriteCommandError("actor_mismatch", "verified actor profile does not match actor id");
  }
  return actor;
}

export type WriteCommandService = ReturnType<typeof createWriteCommandService>;
