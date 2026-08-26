import { createHash, randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../../db/schema.js";
import { hashArguments } from "../../domain/canonical-hash.js";

export { hashArguments } from "../../domain/canonical-hash.js";

type Db = PostgresJsDatabase<typeof schema>;
export type HealthTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class RequestStateError extends Error {
  readonly code = "proposal_stale";

  constructor(readonly reason: string) {
    super(`requestState rejected: ${reason}`);
  }
}

export interface PendingInputBinding {
  userId: string;
  verifiedActor: string;
  runHandle: string;
  toolName: string;
  targetId: string;
  idempotencyKey: string;
  arguments: Record<string, unknown>;
}

export interface IssueInputRequest extends PendingInputBinding {
  prompt: string;
  choices: string[];
  inputRequests?: Record<string, unknown>;
  payload: Record<string, unknown>;
  ttlMs?: number;
}

export interface IssuedInputRequest {
  requestState: string;
  expiresAt: string;
  inputRequests: Record<string, unknown>;
}

interface PendingRow {
  id: string;
  payloadJson: Record<string, unknown>;
  inputRequestsJson: Record<string, unknown>;
}

function stateHash(requestState: string): string {
  return createHash("sha256").update(requestState).digest("hex");
}

export function createRequestStateService(db: Db) {
  async function verify(
    requestState: string,
    binding: { userId: string; verifiedActor: string },
  ): Promise<string> {
    if (!requestState.startsWith("mcp_rs_")) throw new RequestStateError("malformed");
    const [row] = await db.select().from(schema.mcpPendingInputRequests)
      .where(eq(schema.mcpPendingInputRequests.requestStateHash, stateHash(requestState)))
      .limit(1);
    if (!row) throw new RequestStateError("unknown");
    if (row.userId !== binding.userId) throw new RequestStateError("user_mismatch");
    if (row.verifiedActor !== binding.verifiedActor) throw new RequestStateError("actor_mismatch");
    if (row.status === "consumed") {
      const [receipt] = await db.select({ id: schema.mcpWriteReceipts.id })
        .from(schema.mcpWriteReceipts)
        .where(and(
          eq(schema.mcpWriteReceipts.userId, row.userId),
          eq(schema.mcpWriteReceipts.runId, row.runId),
          eq(schema.mcpWriteReceipts.verifiedActor, row.verifiedActor),
          eq(schema.mcpWriteReceipts.toolName, row.toolName),
          eq(schema.mcpWriteReceipts.scopeKey, row.targetId),
          eq(schema.mcpWriteReceipts.idempotencyKey, row.idempotencyKey),
          eq(schema.mcpWriteReceipts.argumentHash, row.argumentHash),
        )).limit(1);
      if (receipt) return requestState;
    }
    if (row.status !== "pending" || row.expiresAt <= new Date()) {
      throw new RequestStateError("expired_or_consumed");
    }
    return requestState;
  }

  async function issue(input: IssueInputRequest): Promise<IssuedInputRequest> {
    const requestState = `mcp_rs_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + (input.ttlMs ?? 10 * 60_000));
    const requestedSchema = input.choices.length > 0
      ? { type: "object", properties: { choice: { type: "string", enum: input.choices } }, required: ["choice"] }
      : { type: "object", properties: { choice: { type: "string" } }, required: ["choice"] };
    const inputRequests = input.inputRequests ?? {
      confirmation: {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: input.prompt,
          requestedSchema,
        },
      },
    };

    await db.insert(schema.mcpPendingInputRequests).values({
      requestStateHash: stateHash(requestState),
      userId: input.userId,
      verifiedActor: input.verifiedActor,
      runId: input.runHandle,
      toolName: input.toolName,
      targetId: input.targetId,
      argumentHash: hashArguments(input.arguments),
      idempotencyKey: input.idempotencyKey,
      inputRequestsJson: inputRequests,
      payloadJson: input.payload,
      expiresAt,
    });

    return { requestState, expiresAt: expiresAt.toISOString(), inputRequests };
  }

  async function consume<T>(
    requestState: string,
    binding: PendingInputBinding,
    effect: (tx: HealthTransaction, pending: PendingRow) => Promise<T>,
  ): Promise<T> {
    if (!requestState.startsWith("mcp_rs_")) {
      throw new RequestStateError("malformed");
    }
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(schema.mcpPendingInputRequests)
        .where(eq(schema.mcpPendingInputRequests.requestStateHash, stateHash(requestState)))
        .limit(1)
        .for("update");
      if (!row) throw new RequestStateError("unknown");
      const mismatch =
        row.userId !== binding.userId ? "user"
          : row.verifiedActor !== binding.verifiedActor ? "actor"
            : row.runId !== binding.runHandle ? "run"
              : row.toolName !== binding.toolName ? "tool"
                : row.targetId !== binding.targetId ? "target"
                  : row.argumentHash !== hashArguments(binding.arguments) ? "arguments"
                    : row.idempotencyKey !== binding.idempotencyKey ? "idempotency_key"
                      : undefined;
      if (mismatch) throw new RequestStateError(`${mismatch}_mismatch`);

      if (row.status === "consumed" && row.consumedAt !== null) {
        return effect(tx, {
          id: row.id,
          payloadJson: row.payloadJson,
          inputRequestsJson: row.inputRequestsJson,
        });
      }
      if (row.status !== "pending") throw new RequestStateError("not_pending");
      if (row.expiresAt <= new Date()) throw new RequestStateError("expired");

      const result = await effect(tx, {
        id: row.id,
        payloadJson: row.payloadJson,
        inputRequestsJson: row.inputRequestsJson,
      });
      await tx.update(schema.mcpPendingInputRequests)
        .set({ status: "consumed", consumedAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(schema.mcpPendingInputRequests.id, row.id),
          eq(schema.mcpPendingInputRequests.status, "pending"),
        ));
      return result;
    });
  }

  return { issue, verify, consume };
}

export type RequestStateService = ReturnType<typeof createRequestStateService>;
