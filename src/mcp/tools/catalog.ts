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
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";

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
import {
  createProjectionWorker,
  ProjectionReplayError,
} from "../../domain/projection-worker.js";
import { createUserLocalDateResolver } from "../../domain/timezone.js";
import { createHealthRecordingService } from "../../domain/health-recording-service.js";
import { createProjectionInvalidationService } from "../../domain/projection-invalidation.js";
import { createBodyProfileService } from "../../domain/body-profile.js";
import { createMediaRetrieval } from "../../media/retrieval.js";
import type { MediaStreamUrlIssuer } from "../../media/signed-stream-url.js";
import { createPainCommand } from "../../training/prepared-session.js";
import {
  createTrainingService,
  TrainingSafetyBlockError,
} from "../../training/training-service.js";
import type { TrainingSetPainInput } from "../../training/training-service.js";
import {
  createSubstitutionEngine,
  SubstitutionProposalError,
  type SubstitutionReasonCode,
} from "../../training/substitution-engine.js";
import {
  createReflectionEngine,
  PlanActivationBlockedError,
  ProposalConflictError,
  type PlanActivationResult,
} from "../../training/reflection-engine.js";
import { createCycleEngine } from "../../training/cycle-engine.js";
import { handleSmartGenerateMealPlan } from "../../tools/handlers.js";
import type { NutritionEstimateResult } from "../../tools/nutrition-estimate.js";
import { createRunHandleService } from "../evidence/run-handles.js";
import { SENSITIVE_RETENTION_POLICY } from "../evidence/privacy-policy.js";
import {
  createSensitivePayloadService,
  type SensitivePayloadServiceOptions,
} from "../evidence/sensitive-payloads.js";
import { createResourceCatalog } from "../resources/catalog.js";
import {
  createRequestStateService,
  RequestStateError,
  type HealthTransaction,
  type PendingInputBinding,
} from "../input/request-state.js";
import { createWriteCommandService, WriteCommandError } from "../writes/command.js";
import type { ActorProfileInput } from "../auth/actor-registry.js";

type Db = PostgresJsDatabase<typeof schema>;

const ISO_DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } as const;
const PLAN_TARGET_PROPERTIES = {
  dayRole: { type: "string", enum: ["A", "B", "C"] },
  exerciseSlug: { type: "string", minLength: 1 },
} as const;
const PLAN_CHANGE_SCHEMA = {
  oneOf: [
    planChangeObject("reorder_exercises", {
      dayRole: PLAN_TARGET_PROPERTIES.dayRole,
      order: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
    }, ["dayRole", "order"]),
    planChangeObject("replace_exercise", {
      ...PLAN_TARGET_PROPERTIES,
      replacementExerciseSlug: { type: "string", minLength: 1 },
    }, ["dayRole", "exerciseSlug", "replacementExerciseSlug"]),
    planChangeObject("update_sets", {
      ...PLAN_TARGET_PROPERTIES,
      sets: { type: "integer", minimum: 1, maximum: 10 },
    }, ["dayRole", "exerciseSlug", "sets"]),
    planChangeObject("update_rep_range", {
      ...PLAN_TARGET_PROPERTIES,
      repRangeLow: { type: "integer", minimum: 1, maximum: 100 },
      repRangeHigh: { type: "integer", minimum: 1, maximum: 100 },
    }, ["dayRole", "exerciseSlug", "repRangeLow", "repRangeHigh"]),
    planChangeObject("update_rir", {
      ...PLAN_TARGET_PROPERTIES,
      rirLow: { type: "integer", minimum: 0, maximum: 10 },
      rirHigh: { type: "integer", minimum: 0, maximum: 10 },
    }, ["dayRole", "exerciseSlug", "rirLow", "rirHigh"]),
    planChangeObject("update_alternatives", {
      ...PLAN_TARGET_PROPERTIES,
      alternatives: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: { type: "string", minLength: 1 } },
    }, ["dayRole", "exerciseSlug", "alternatives"]),
    planChangeObject("update_cycle_pattern", {
      cyclePattern: { type: "array", minItems: 2, maxItems: 14, items: { type: "string", enum: ["A", "B", "C", "REST"] } },
    }, ["cyclePattern"]),
    planChangeObject("update_cue_refs", {
      ...PLAN_TARGET_PROPERTIES,
      cueRefs: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } },
    }, ["dayRole", "exerciseSlug", "cueRefs"]),
    planChangeObject("remove_exercise", PLAN_TARGET_PROPERTIES, ["dayRole", "exerciseSlug"]),
    planChangeObject("add_exercise", {
      ...PLAN_TARGET_PROPERTIES,
      sets: { type: "integer", minimum: 1, maximum: 10 },
      repRangeLow: { type: "integer", minimum: 1, maximum: 100 },
      repRangeHigh: { type: "integer", minimum: 1, maximum: 100 },
      rirLow: { type: "integer", minimum: 0, maximum: 10 },
      rirHigh: { type: "integer", minimum: 0, maximum: 10 },
      alternatives: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", minLength: 1 } },
      cueRefs: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } },
      note: { type: "string", maxLength: 500 },
    }, ["dayRole", "exerciseSlug", "sets"]),
  ],
} as const;

function planChangeObject(
  kind: string,
  properties: Record<string, unknown>,
  required: string[],
) {
  return {
    type: "object",
    properties: { kind: { const: kind }, ...properties },
    required: ["kind", ...required],
    additionalProperties: false,
  };
}

export interface ToolInvocation {
  principalUserId: string;
  actor: string;
  actorId?: string;
  actorProfile?: ActorProfileInput;
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

interface MealCorrectionConfirmationPayload {
  originalLogId: string;
  description: string;
  mealType: string;
  reason: string;
  estimate: NutritionEstimateResult;
}

class MealCorrectionInputRequired extends Error {
  constructor(readonly payload: MealCorrectionConfirmationPayload) {
    super("meal correction needs candidate confirmation");
  }
}

/** MCP form shape shared by meal creation and correction resolution. */
function nutritionResolutionRequest(estimate: NutritionEstimateResult): {
  prompt: string;
  inputRequests: Record<string, unknown>;
} {
  const promptItems = [
    ...(estimate.needsConfirmation ?? []).map((diagnostic) => diagnostic.segment),
    ...(estimate.unmatched ?? []).map((diagnostic) => `${diagnostic.segment} (未匹配)`),
  ];
  const inputRequests: Record<string, unknown> = {};
  (estimate.needsConfirmation ?? []).forEach((diagnostic, index) => {
    inputRequests[`candidate_${index}`] = {
      method: "elicitation/create",
      params: {
        mode: "form",
        message: `请选择“${diagnostic.segment}”对应的食物`,
        requestedSchema: {
          type: "object",
          properties: {
            choice: {
              type: "string",
              enum: diagnostic.candidates
                .map((candidate) => candidate.slug || candidate.label)
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
        message: `请输入“${diagnostic.segment}”对应的明确食物名称`,
        requestedSchema: {
          type: "object",
          properties: { choice: { type: "string" } },
          required: ["choice"],
        },
      },
    };
  });
  return {
    prompt: `这些食材需要确认：${promptItems.join("、") || "份量不确定"}`,
    inputRequests,
  };
}

export function createHealthToolCatalog(
  db: Db,
  repo: Repository,
  options: {
    toolContext?: ToolContext;
    conformanceProfile?: boolean;
    now?: () => Date;
    /** null means explicitly disabled; undefined preserves legacy BFF paths. */
    mediaStreamUrlIssuer?: MediaStreamUrlIssuer | null;
    sensitivePayloads?: SensitivePayloadServiceOptions;
  } = {},
) {
  const runs = createRunHandleService(db, { sensitivePayloads: options.sensitivePayloads });
  const diet = createDietLogService(db, repo);
  const requestStates = createRequestStateService(db);
  const writes = createWriteCommandService(db, { sensitivePayloads: options.sensitivePayloads });
  const getUserLocalDate = createUserLocalDateResolver(db, options.now);
  const resourceCatalog = createResourceCatalog(db, repo, { now: options.now });

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
      ...(invocation.actorId ? { actorId: invocation.actorId } : {}),
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
      ...(invocation.actorId ? { actorId: invocation.actorId } : {}),
      ...(invocation.actorProfile ? { actorProfile: invocation.actorProfile } : {}),
      runHandle: runHandle.trim(),
      toolName,
      scopeKey,
      idempotencyKey: str(invocation.args, "idempotencyKey"),
      arguments: invocation.args,
    };
  }

  /** Require a valid, actor-bound run handle for confirmation/proposal tools. */
  async function requireRun(invocation: ToolInvocation) {
    const runHandle = String(invocation.args["runHandle"] ?? "");
    if (!runHandle) {
      throw new Error("run_handle_required: call health_begin_run first; writes without a run are not accepted");
    }
    // Ownership check (throws RunHandleError when foreign/unknown).
    return runs.getRun(invocation.principalUserId, runHandle, invocation.actorId);
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

  function num(args: Record<string, unknown>, key: string): number {
    const value = optNum(args, key);
    if (value === undefined) throw new RangeError(`${key} must be a finite number`);
    return value;
  }

  function setPainEntries(args: Record<string, unknown>): TrainingSetPainInput[] {
    const raw = args["pain"];
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new RangeError("pain must be an array");
    const allowed = new Set(["mild", "sharp", "worsening", "unstable", "unknown"]);
    return raw.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new RangeError(`pain[${index}] must be an object`);
      }
      const value = entry as Record<string, unknown>;
      const bodyPart = typeof value["bodyPart"] === "string" ? value["bodyPart"].trim() : "";
      const severity = typeof value["severity"] === "string" ? value["severity"] : "";
      if (!bodyPart) throw new RangeError(`pain[${index}].bodyPart is required`);
      if (!allowed.has(severity)) throw new RangeError(`pain[${index}].severity is invalid`);
      const description = typeof value["description"] === "string"
        ? value["description"].trim()
        : "";
      return {
        bodyPart,
        severity: severity as TrainingSetPainInput["severity"],
        ...(description ? { description } : {}),
      };
    });
  }

  function stringList(args: Record<string, unknown>, key: string): string[] {
    const raw = args[key];
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new RangeError(`${key} must be an array`);
    const values = raw.map((value, index) => {
      if (typeof value !== "string" || value.trim() === "") {
        throw new RangeError(`${key}[${index}] must be a non-empty string`);
      }
      return value.trim();
    });
    return [...new Set(values)];
  }

  /**
   * Prefer the Agent's explicit food/quantity conversion over reparsing the
   * conversational audit text. The domain estimator still owns catalog
   * matching, natural-unit conversion, nutrition, and ambiguity handling.
   */
  function mealDescriptionForEstimate(args: Record<string, unknown>): string {
    const rawItems = args["items"];
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new RangeError("items must be a non-empty Agent-converted array");
    }

    return rawItems.map((rawItem, index) => {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
        throw new RangeError(`items[${index}] must be an object`);
      }
      const item = rawItem as Record<string, unknown>;
      const name = typeof item["name"] === "string" ? item["name"].trim() : "";
      const quantity = Number(item["quantity"]);
      const unit = typeof item["unit"] === "string" ? item["unit"].trim() : "";
      if (!name) throw new RangeError(`items[${index}].name is required`);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new RangeError(`items[${index}].quantity must be greater than zero`);
      }
      if (!unit || unit.length > 30 || /[,，、;；+]/.test(unit)) {
        throw new RangeError(`items[${index}].unit is invalid`);
      }
      return `${quantity}${unit}${name}`;
    }).join("，");
  }

  function mealResolutionMode(args: Record<string, unknown>): "confirm" | "agent_estimate" {
    const mode = str(args, "resolutionMode");
    if (mode !== "confirm" && mode !== "agent_estimate") {
      throw new RangeError("resolutionMode must be confirm or agent_estimate");
    }
    return mode;
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

  async function today(userId: string): Promise<string> {
    return getUserLocalDate(userId);
  }

  async function trackedResourceBody(
    invocation: ToolInvocation,
    toolName: string,
    uri: string,
  ): Promise<unknown> {
    const runHandle = str(invocation.args, "runHandle");
    const result = await resourceCatalog.readResource({
      userId: invocation.principalUserId,
      externalUserId: "transport-verified",
      actor: invocation.actor,
      actorId: invocation.actorId ?? "direct-catalog",
      actorProfile: {
        verifiedActor: invocation.actor,
        actorType: invocation.actorProfile?.actorType ?? "other",
        runtimeName: invocation.actorProfile?.runtimeName ?? invocation.actor,
        runtimeVersion: invocation.actorProfile?.runtimeVersion ?? null,
        agentProfile: invocation.actorProfile?.agentProfile ?? invocation.actor,
        agentProfileVersion: invocation.actorProfile?.agentProfileVersion ?? null,
        modelProvider: invocation.actorProfile?.modelProvider ?? null,
        modelName: invocation.actorProfile?.modelName ?? null,
      },
    }, uri);
    await runs.recordStep({
      userId: invocation.principalUserId,
      runHandle,
      ...(invocation.actorId ? { actorId: invocation.actorId } : {}),
      stage: "tool_call",
      mcpMethod: "tools/call",
      mcpName: toolName,
      aggregateType: result.evidence.aggregateType,
      aggregateId: result.evidence.aggregateId,
      stateRevisionAfter: result.evidence.stateRevision,
      arguments: invocation.args,
      resultSummary: result.evidence.resultSummary,
    });
    return JSON.parse(result.contents[0]!.text) as unknown;
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

  async function persistDietCorrection(
    tx: HealthTransaction,
    invocation: ToolInvocation,
    context: ToolContext,
    payload: MealCorrectionConfirmationPayload,
    overrideEstimate: NutritionEstimateResult,
  ) {
    const txDb = tx as unknown as Db;
    const txCtx: ToolContext = { ...context, db: txDb, repo: createRepository(txDb) };
    const corrected = await createDietLogService(txDb, txCtx.repo).correct(txCtx, {
      userId: invocation.principalUserId,
      originalLogId: payload.originalLogId,
      description: payload.description,
      mealType: payload.mealType,
      reason: payload.reason,
      idempotencyKey: str(invocation.args, "idempotencyKey"),
      overrideEstimate,
    });
    const [readBack] = await tx.select().from(schema.dietLogs)
      .where(and(
        eq(schema.dietLogs.id, corrected.revised.id),
        eq(schema.dietLogs.userId, invocation.principalUserId),
      )).limit(1);
    const outbox = await tx.select({ id: schema.outboxEvents.id }).from(schema.outboxEvents)
      .where(and(
        eq(schema.outboxEvents.userId, invocation.principalUserId),
        eq(schema.outboxEvents.aggregateId, corrected.revised.id),
        eq(schema.outboxEvents.eventType, "diet.correct"),
      ));
    if (!readBack || outbox.length !== 1) throw new Error("diet correction read-back failed");
    return {
      response: {
        correctedLogId: readBack.id,
        supersededLogId: corrected.original.id,
        caloriesKcal: readBack.caloriesKcal,
      },
      factRefs: [{ type: "diet_log", id: readBack.id }],
      outboxEventIds: outbox.map((event) => event.id),
    };
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
          objective: { type: "string", maxLength: 500, description: "What this journey tries to do (one line)." },
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
          ...(inv.actorId ? { actorId: inv.actorId } : {}),
          ...(inv.actorProfile ? { actorProfile: inv.actorProfile } : {}),
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
          responseSummary: { type: "string", maxLength: 1000 },
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
        const userAccepted = typeof inv.args["userAccepted"] === "boolean"
          ? inv.args["userAccepted"]
          : undefined;
        const observedOn = await today(inv.principalUserId);
        const result = await writes.execute(
          writeInput(inv, "health_end_run", runHandle),
          async (tx) => {
            const rawResponseSummary = optStr(inv.args, "responseSummary");
            const protectedResponseSummary = rawResponseSummary === undefined
              ? undefined
              : await createSensitivePayloadService(
                  tx as unknown as Db,
                  options.sensitivePayloads,
                ).protectText({
                  userId: inv.principalUserId,
                  payloadType: "agent_response_summary",
                  plaintext: rawResponseSummary.slice(0, 1000),
                  retentionDays: SENSITIVE_RETENTION_POLICY.agentResponseSummary.days,
                });
            const [updated] = await tx.update(schema.agentRuns).set({
              outcome,
              finishedAt: new Date(),
              updatedAt: new Date(),
              ...(protectedResponseSummary
                ? {
                    responseSummary: protectedResponseSummary.evidenceText.slice(0, 1000),
                    responseSummaryPayloadId: protectedResponseSummary.payloadId,
                  }
                : {}),
            }).where(and(
              eq(schema.agentRuns.id, runHandle),
              eq(schema.agentRuns.userId, inv.principalUserId),
              eq(schema.agentRuns.outcome, "running"),
            )).returning();
            if (!updated) throw new WriteCommandError("run_handle_invalid", "run is already closed");
            const [audit] = await tx.insert(schema.interactionEvents).values({
              userId: inv.principalUserId,
              requestId: runHandle,
              journeyId: updated.journeyId,
              actor: `mcp:${inv.actor}`,
              stage: "agent_run",
              stageCode: "ended",
              detailJson: { runId: runHandle, outcome },
            }).returning({ id: schema.interactionEvents.id });
            if (!audit) throw new Error("run end audit insert failed");
            const outboxEventIds: string[] = [];
            const factRefs: Array<{ type: string; id: string }> = [
              { type: "agent_run", id: runHandle },
            ];
            if (userAccepted !== undefined) {
              const [decision] = await tx.insert(schema.userDecisionEvents).values({
                userId: inv.principalUserId,
                decisionType: userAccepted ? "accepted" : "rejected",
                subjectJson: {
                  type: "agent_run_outcome",
                  runId: runHandle,
                  accepted: userAccepted,
                  outcome,
                },
                journeyId: updated.journeyId,
              }).returning({ id: schema.userDecisionEvents.id });
              if (!decision) throw new Error("run outcome decision insert failed");
              const [decisionOutbox] = await tx.insert(schema.outboxEvents).values({
                userId: inv.principalUserId,
                aggregateType: "user_decision",
                aggregateId: decision.id,
                eventType: "user.decision_recorded",
                payloadJson: { observedOn, type: "agent_run_outcome", runId: runHandle },
              }).returning({ id: schema.outboxEvents.id });
              if (!decisionOutbox) throw new Error("run outcome decision outbox insert failed");
              outboxEventIds.push(decisionOutbox.id);
              factRefs.push({ type: "user_decision", id: decision.id });
            }
            const [count] = await tx.select({ n: sql<number>`count(*)::int` })
              .from(schema.agentRunSteps)
              .where(eq(schema.agentRunSteps.runId, runHandle));
            return {
              response: {
                runHandle,
                outcome: updated.outcome,
                userAccepted: userAccepted ?? null,
                stepCount: (count?.n ?? 0) + 1,
              },
              factRefs,
              outboxEventIds,
              auditEventIds: [audit.id],
            };
          },
        );
        return complete(result.response);
      },
    },
    {
      name: "health_update_body_profile",
      description: "Record an effective-dated body profile version and recompute calorie and macro targets.",
      risk: "state-change",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          effectiveDate: ISO_DATE,
          sex: { type: "string", enum: ["male", "female"] },
          ageYears: { type: "integer", minimum: 18, maximum: 120 },
          heightCm: { type: "number", exclusiveMinimum: 0, maximum: 300 },
          weightKg: { type: "number", exclusiveMinimum: 0, maximum: 500 },
          goalWeightKg: { type: "number", exclusiveMinimum: 0, maximum: 500 },
          activityLevel: {
            type: "string",
            enum: ["sedentary", "lightly_active", "moderately_active", "strength_training"],
          },
          goal: {
            type: "string",
            enum: [
              "improve_health",
              "body_recomp",
              "fat_loss_slow",
              "fat_loss_moderate",
              "fat_loss_fast",
              "muscle_gain_slow",
              "muscle_gain_moderate",
              "muscle_gain_fast",
            ],
          },
          trainingCadence: { type: "string", minLength: 1, maxLength: 100 },
          trainingSplit: { type: "string", minLength: 1, maxLength: 100 },
          idempotencyKey: { type: "string" },
        },
        required: [
          "runHandle",
          "effectiveDate",
          "sex",
          "ageYears",
          "heightCm",
          "weightKg",
          "goalWeightKg",
          "activityLevel",
          "goal",
          "trainingCadence",
          "trainingSplit",
          "idempotencyKey",
        ],
      },
      execute: async (inv) => {
        const effectiveDate = str(inv.args, "effectiveDate");
        const result = await writes.execute(
          writeInput(inv, "health_update_body_profile", effectiveDate),
          async (tx) => {
            const recorded = await createBodyProfileService(tx as unknown as Db)
              .recordEffectiveProfile(inv.principalUserId, {
                effectiveDate,
                sex: str(inv.args, "sex") as "male" | "female",
                ageYears: num(inv.args, "ageYears"),
                heightCm: num(inv.args, "heightCm"),
                weightKg: num(inv.args, "weightKg"),
                goalWeightKg: num(inv.args, "goalWeightKg"),
                activityLevel: str(inv.args, "activityLevel") as
                  | "sedentary"
                  | "lightly_active"
                  | "moderately_active"
                  | "strength_training",
                goal: str(inv.args, "goal") as
                  | "improve_health"
                  | "body_recomp"
                  | "fat_loss_slow"
                  | "fat_loss_moderate"
                  | "fat_loss_fast"
                  | "muscle_gain_slow"
                  | "muscle_gain_moderate"
                  | "muscle_gain_fast",
                trainingCadence: str(inv.args, "trainingCadence"),
                trainingSplit: str(inv.args, "trainingSplit"),
              });
            return {
              response: { profile: recorded.profile, plan: recorded.plan },
              factRefs: [{ type: "body_profile", id: recorded.profile.id }],
              outboxEventIds: [recorded.outboxEventId],
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
        const startDate = optStr(inv.args, "startDate")
          ?? addDays(await today(inv.principalUserId), 1);
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
            const entryCountByDate = new Map<string, number>();
            for (const row of rows) {
              entryCountByDate.set(row.planDate, (entryCountByDate.get(row.planDate) ?? 0) + 1);
            }
            const invalidation = await createProjectionInvalidationService(txDb)
              .invalidateDietPlanRange({
                userId: inv.principalUserId,
                startDate,
                dayCount: 7,
                status: generated.status,
                entryCountByDate,
              });
            return {
              response: {
                startDate,
                endDate,
                entryCount: rows.length,
                generation: generated,
              } as unknown as Record<string, unknown>,
              factRefs,
              outboxEventIds: invalidation.outboxEventIds,
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
        required: ["startDate", "runHandle"],
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
        await runs.recordStep({
          userId: inv.principalUserId,
          runHandle: str(inv.args, "runHandle"),
          stage: "tool_call",
          mcpMethod: "tools/call",
          mcpName: "health_get_diet_plan",
          aggregateType: "diet_plan",
          aggregateId: `${inv.principalUserId}:${startDate}:${endDate}`,
          arguments: inv.args,
          resultSummary: { startDate, endDate, entryCount: entries.length },
        });
        return complete({ startDate, endDate, entries });
      },
    },
    {
      name: "health_get_daily_state",
      description: "Read one projected daily health state inside a formal run.",
      risk: "read-only",
      inputSchema: {
        type: "object",
        properties: { runHandle: { type: "string" }, date: ISO_DATE },
        required: ["runHandle"],
      },
      execute: async (inv) => complete(
        await trackedResourceBody(
          inv,
          "health_get_daily_state",
          `health://daily-state/${optStr(inv.args, "date") ?? "today"}`,
        ) as Record<string, unknown>,
      ),
    },
    {
      name: "health_get_active_constraints",
      description: "Read active dated safety constraints inside a formal run.",
      risk: "read-only",
      inputSchema: {
        type: "object",
        properties: { runHandle: { type: "string" }, date: ISO_DATE },
        required: ["runHandle"],
      },
      execute: async (inv) => {
        const date = optStr(inv.args, "date") ?? await today(inv.principalUserId);
        const constraints = await trackedResourceBody(
          inv,
          "health_get_active_constraints",
          `health://constraints/active/${date}`,
        );
        return complete({ date, constraints: Array.isArray(constraints) ? constraints : [] });
      },
    },
    {
      name: "health_get_training_cycle",
      description: "Read current cycle positions and next-day decision inside a formal run.",
      risk: "read-only",
      inputSchema: {
        type: "object",
        properties: { runHandle: { type: "string" } },
        required: ["runHandle"],
      },
      execute: async (inv) => complete(
        await trackedResourceBody(
          inv,
          "health_get_training_cycle",
          "health://training/cycles/current",
        ) as Record<string, unknown>,
      ),
    },
    {
      name: "health_get_active_plan",
      description: "Read the active compiled training plan inside a formal run.",
      risk: "read-only",
      inputSchema: {
        type: "object",
        properties: { runHandle: { type: "string" } },
        required: ["runHandle"],
      },
      execute: async (inv) => complete(
        await trackedResourceBody(
          inv,
          "health_get_active_plan",
          "health://plans/training/active",
        ) as Record<string, unknown>,
      ),
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
          runHandle: { type: "string" },
        },
        required: ["runHandle"],
      },
      execute: async (inv) => {
        if (options.mediaStreamUrlIssuer === null) {
          return toolError("domain_unavailable", "training media runtime is disabled");
        }
        const segments = await createMediaRetrieval(db, {
          ...(options.mediaStreamUrlIssuer
            ? { issueStreamUrl: options.mediaStreamUrlIssuer }
            : {}),
        }).search({
          ...(optStr(inv.args, "movementPattern") ? { movementPattern: optStr(inv.args, "movementPattern") } : {}),
          ...(optStr(inv.args, "bodyPart") ? { bodyPart: optStr(inv.args, "bodyPart") } : {}),
          ...(optStr(inv.args, "category") ? { category: optStr(inv.args, "category") } : {}),
          ...(optStr(inv.args, "text") ? { text: optStr(inv.args, "text") } : {}),
          ...(optNum(inv.args, "limit") ? { limit: Math.min(50, Math.max(1, Math.round(optNum(inv.args, "limit")!))) } : {}),
        });
        await runs.recordStep({
          userId: inv.principalUserId,
          runHandle: str(inv.args, "runHandle"),
          ...(inv.actorId ? { actorId: inv.actorId } : {}),
          stage: "tool_call",
          mcpMethod: "tools/call",
          mcpName: "health_search_training_media",
          aggregateType: "training_media_search",
          aggregateId: inv.principalUserId,
          arguments: inv.args,
          resultSummary: {
            segmentCount: segments.length,
            segmentIds: segments.map((segment) => segment.segmentId),
          },
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
              payloadJson: {
                observedOn: await today(inv.principalUserId),
                segmentId,
                helpful,
              },
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
        properties: { runHandle: { type: "string" }, date: ISO_DATE },
        required: ["runHandle"],
      },
      execute: async (inv) => {
        const date = optStr(inv.args, "date") ?? await today(inv.principalUserId);
        const diagnostics = await createProjectionWorker(db, repo)
          .getDiagnostics(inv.principalUserId, date);
        await runs.recordStep({
          userId: inv.principalUserId,
          runHandle: str(inv.args, "runHandle"),
          stage: "tool_call",
          mcpMethod: "tools/call",
          mcpName: "health_get_projection_diagnostics",
          aggregateType: "projection_diagnostics",
          aggregateId: `${inv.principalUserId}:${date}`,
          arguments: inv.args,
          resultSummary: {
            date,
            status: diagnostics.status,
            outbox: diagnostics.outbox,
          },
        });
        return complete(diagnostics);
      },
    },
    {
      name: "health_replay_projection",
      description: "Requeue and drain this user's dated dead letters, rebuild from facts, verify fresh diagnostics, and write an operational audit.",
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
        const date = optStr(inv.args, "date") ?? await today(inv.principalUserId);
        const result = await writes.execute(
          writeInput(inv, "health_replay_projection", date),
          async (tx) => {
            const txDb = tx as unknown as Db;
            const worker = createProjectionWorker(txDb, createRepository(txDb));
            const revived = await worker.replayDeadLetters(inv.principalUserId, date);
            const drained = await worker.drainUserDate(inv.principalUserId, date);
            await worker.rebuildUserProjection(inv.principalUserId, date);
            const [projection] = await tx.select().from(schema.dailyHealthStateProjection)
              .where(and(
                eq(schema.dailyHealthStateProjection.userId, inv.principalUserId),
                eq(schema.dailyHealthStateProjection.stateDate, date),
              )).limit(1);
            if (!projection) throw new Error("projection replay read-back failed");
            const diagnostics = await worker.getDiagnostics(inv.principalUserId, date);
            if (
              diagnostics.status !== "fresh"
              || diagnostics.outbox.pending !== 0
              || diagnostics.outbox.processing !== 0
              || diagnostics.outbox.deadLetter !== 0
            ) {
              throw new ProjectionReplayError(diagnostics);
            }
            const [audit] = await tx.insert(schema.interactionEvents).values({
              userId: inv.principalUserId,
              requestId: str(inv.args, "runHandle"),
              actor: `mcp:${inv.actor}`,
              stage: "projection_replay",
              stageCode: "ok",
              detailJson: {
                localDate: date,
                revived,
                drained: drained.succeeded,
                revision: projection.revision,
              },
            }).returning({ id: schema.interactionEvents.id });
            if (!audit) throw new Error("projection replay audit failed");
            return {
              response: {
                date,
                revived,
                drained: drained.succeeded,
                revision: projection.revision,
                status: diagnostics.status,
                diagnostics,
              },
              factRefs: [
                { type: "daily_state_projection", id: `${inv.principalUserId}:${date}` },
                { type: "operational_audit", id: audit.id },
              ],
              outboxEventIds: [],
              auditEventIds: [audit.id],
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
        inv.actorId,
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
        const date = optStr(inv.args, "date") ?? await today(inv.principalUserId);
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
      description: "Log a meal only after the Agent converts the user's natural language into structured food items. Preserve the user's original words in description. items and resolutionMode are mandatory: use confirm when the user wants candidate confirmation; use agent_estimate when the user asked the Agent to handle uncertainty without another question. agent_estimate persists low-confidence assumptions as uncertain instead of silently treating them as exact.",
      risk: "revocable-write",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          date: ISO_DATE,
          mealType: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
          description: { type: "string", description: "The user's original meal description, retained as audit text." },
          items: {
            type: "array",
            minItems: 1,
            maxItems: 30,
            description: "Agent-converted food entries. Prefer this over asking the user to format their input.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", minLength: 1, maxLength: 200 },
                quantity: { type: "number", exclusiveMinimum: 0 },
                unit: {
                  type: "string",
                  minLength: 1,
                  maxLength: 30,
                  description: "Reported or Agent-normalized unit, including catalog units such as 个、把、棵、克、毫升.",
                },
              },
              required: ["name", "quantity", "unit"],
              additionalProperties: false,
            },
          },
          resolutionMode: {
            type: "string",
            enum: ["confirm", "agent_estimate"],
            description: "confirm uses MRTR for ambiguity; agent_estimate records explicit low-confidence assumptions without asking again.",
          },
          idempotencyKey: { type: "string", description: "Stable key for retries." },
          expectedRevision: { type: "number" },
        },
        required: ["runHandle", "mealType", "description", "items", "resolutionMode", "idempotencyKey"],
      },
      execute: async (inv) => {
        await requireRun(inv);
        const ctx = await buildToolContext(inv.principalUserId);
        try {
          const idempotencyKey = str(inv.args, "idempotencyKey");

          // MRTR retry path: apply the user's confirmed resolution.
          if (inv.requestState !== undefined) {
            const targetId = `diet:${optStr(inv.args, "date") ?? await today(inv.principalUserId)}:${str(inv.args, "mealType")}`;
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
            description: mealDescriptionForEstimate(inv.args),
            date: optStr(inv.args, "date") ?? await today(inv.principalUserId),
            mealType: str(inv.args, "mealType"),
            resolutionMode: mealResolutionMode(inv.args),
          });
          if (previewResult.status === "needs_confirmation") {
            const date = optStr(inv.args, "date") ?? await today(inv.principalUserId);
            const mealType = str(inv.args, "mealType");
            const resolution = nutritionResolutionRequest(previewResult.estimate);
            return await makeConfirmation(
              "health_log_meal", `diet:${date}:${mealType}`, inv,
              resolution.prompt,
              [],
              {
                date,
                mealType,
                description: str(inv.args, "description"),
                estimate: previewResult.estimate as unknown as Record<string, unknown>,
              },
              resolution.inputRequests,
            );
          }

          // Clean estimate -> commit directly.
          const date = optStr(inv.args, "date") ?? await today(inv.principalUserId);
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
                overrideEstimate: previewResult.estimate,
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
        try {
          await requireRun(inv);
          const ctx = await buildToolContext(inv.principalUserId);
          const originalLogId = str(inv.args, "dietLogId");

          if (inv.requestState !== undefined) {
            const committed = await requestStates.consume(
              inv.requestState,
              pendingBinding("health_correct_meal", originalLogId, inv),
              async (tx, pending) => {
                const payload = pending.payloadJson as unknown as MealCorrectionConfirmationPayload;
                const txDb = tx as unknown as Db;
                const txCtx: ToolContext = { ...ctx, db: txDb, repo: createRepository(txDb) };
                const resolved = await resolveConfirmedFoodCandidates(
                  txCtx,
                  payload.estimate,
                  acceptedSelections(inv.inputResponses),
                );
                return writes.executeInTransaction(
                  tx,
                  writeInput(inv, "health_correct_meal", originalLogId),
                  (writeTx) => persistDietCorrection(writeTx, inv, txCtx, payload, resolved),
                );
              },
            );
            return complete(committed.response);
          }

          const result = await writes.execute(
            writeInput(inv, "health_correct_meal", originalLogId),
            async (tx) => {
              const txDb = tx as unknown as Db;
              const txCtx: ToolContext = { ...ctx, db: txDb, repo: createRepository(txDb) };
              const correctionPreview = await createDietLogService(txDb, txCtx.repo).previewCorrection(txCtx, {
                userId: inv.principalUserId,
                originalLogId,
                ...(optStr(inv.args, "description") ? { description: optStr(inv.args, "description") } : {}),
                ...(optStr(inv.args, "mealType") ? { mealType: optStr(inv.args, "mealType") } : {}),
              });
              const payload: MealCorrectionConfirmationPayload = {
                originalLogId,
                description: correctionPreview.description,
                mealType: correctionPreview.mealType,
                reason: optStr(inv.args, "reason") ?? "mcp correction",
                estimate: correctionPreview.estimate,
              };
              if (correctionPreview.status === "needs_confirmation") {
                throw new MealCorrectionInputRequired(payload);
              }
              return persistDietCorrection(tx, inv, txCtx, payload, correctionPreview.estimate);
            },
          );
          return complete(result.response);
        } catch (error) {
          if (error instanceof MealCorrectionInputRequired) {
            const resolution = nutritionResolutionRequest(error.payload.estimate);
            return await makeConfirmation(
              "health_correct_meal",
              str(inv.args, "dietLogId"),
              inv,
              resolution.prompt,
              [],
              error.payload as unknown as Record<string, unknown>,
              resolution.inputRequests,
            );
          }
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
        const date = optStr(inv.args, "date") ?? await today(inv.principalUserId);
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
        const date = optStr(inv.args, "date") ?? await today(inv.principalUserId);
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
        const date = optStr(inv.args, "date") ?? await today(inv.principalUserId);
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
        const date = optStr(inv.args, "date") ?? await today(inv.principalUserId);
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
        const date = optStr(inv.args, "date") ?? await today(inv.principalUserId);
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
        await requireRun(inv);
        const constraintId = str(inv.args, "constraintId");
        if (inv.requestState === undefined) {
          const [constraint] = await db.select().from(schema.healthConstraints)
            .where(and(
              eq(schema.healthConstraints.id, constraintId),
              eq(schema.healthConstraints.userId, inv.principalUserId),
              isNull(schema.healthConstraints.liftedAt),
            )).limit(1);
          if (!constraint) {
            return toolError("not_found", "constraint not found or already lifted");
          }
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
        const date = optStr(inv.args, "date") ?? await today(inv.principalUserId);
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
                planVersionId: proposal.planVersionId ?? null,
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
                  sessionDate: optStr(inv.args, "date") ?? await today(inv.principalUserId),
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
      description: "Record one training set with optional muscle feel and pain feedback. Pain is escalated into an observation and active constraint.",
      risk: "revocable-write",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          trainingSessionId: { type: "string" },
          sessionExerciseId: { type: "string" },
          setNumber: { type: "integer", minimum: 1 },
          loadValue: { type: "number", minimum: 0 },
          loadUnit: { type: "string", enum: ["kg", "lb", "bodyweight"] },
          reps: { type: "integer", minimum: 0 },
          rir: { type: "integer", minimum: 0, maximum: 10 },
          targetMuscleFeel: { type: "integer", minimum: 1, maximum: 5 },
          pain: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              properties: {
                bodyPart: { type: "string", minLength: 1, maxLength: 100 },
                severity: {
                  type: "string",
                  enum: ["mild", "sharp", "worsening", "unstable", "unknown"],
                },
                description: { type: "string", maxLength: 500 },
              },
              required: ["bodyPart", "severity"],
              additionalProperties: false,
            },
          },
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
              targetMuscleFeel: optNum(inv.args, "targetMuscleFeel") ?? null,
              pain: setPainEntries(inv.args),
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
            const painAggregateIds = recorded.painResults.map((pain) => pain.constraintId);
            const outboxAggregateIds = [recorded.log.id, ...painAggregateIds];
            const outbox = await tx.select({ id: schema.outboxEvents.id }).from(schema.outboxEvents)
              .where(and(
                eq(schema.outboxEvents.userId, inv.principalUserId),
                inArray(schema.outboxEvents.aggregateId, outboxAggregateIds),
              ));
            if (!readBack || outbox.length === 0) throw new Error("training set read-back failed");
            return {
              response: {
                setId: readBack.id,
                exerciseCompleted: recorded.exerciseCompleted,
                factCommitted: true,
                projectionStatus: "pending",
                projectionRevision: null,
                painEscalated: recorded.painResults.length > 0,
                painConstraintIds: painAggregateIds,
              },
              factRefs: [
                { type: "training_set", id: readBack.id },
                ...recorded.painResults.flatMap((pain) => [
                  { type: "pain_observation", id: pain.observationId },
                  { type: "health_constraint", id: pain.constraintId },
                ]),
              ],
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
      description: "Propose equipment-aware substitutes for an unfinished exercise. Unavailable equipment is excluded before candidates are ranked.",
      risk: "proposal",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          trainingSessionId: { type: "string" },
          sessionExerciseId: { type: "string" },
          reasonCode: {
            type: "string",
            enum: ["equipment_occupied", "equipment_unavailable", "comfort", "preference"],
          },
          unavailableEquipment: {
            type: "array",
            items: { type: "string", minLength: 1 },
            uniqueItems: true,
          },
          availableEquipment: {
            type: "array",
            items: { type: "string", minLength: 1 },
            uniqueItems: true,
          },
          occupiedExerciseSlug: { type: "string" },
          idempotencyKey: { type: "string" },
        },
        required: [
          "runHandle",
          "trainingSessionId",
          "sessionExerciseId",
          "reasonCode",
          "unavailableEquipment",
          "idempotencyKey",
        ],
      },
      execute: async (inv) => {
        const sessionId = str(inv.args, "trainingSessionId");
        const exerciseId = str(inv.args, "sessionExerciseId");
        const result = await writes.execute(
          writeInput(inv, "health_propose_substitution", `${sessionId}:${exerciseId}`),
          async (tx) => {
            const proposal = await createSubstitutionEngine(tx as unknown as Db)
              .propose(inv.principalUserId, sessionId, exerciseId, {
                reasonCode: str(inv.args, "reasonCode") as SubstitutionReasonCode,
                unavailableEquipment: stringList(inv.args, "unavailableEquipment"),
                ...(stringList(inv.args, "availableEquipment").length > 0
                  ? { availableEquipment: stringList(inv.args, "availableEquipment") }
                  : {}),
                ...(optStr(inv.args, "occupiedExerciseSlug")
                  ? { occupiedExerciseSlug: optStr(inv.args, "occupiedExerciseSlug") }
                  : {}),
              });
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
      description: "Apply a persisted substitution proposal. The user chooses one offered candidate through a standard MRTR input response.",
      risk: "confirmation",
      inputSchema: {
        type: "object",
        properties: {
          runHandle: { type: "string" },
          substitutionProposalId: { type: "string" },
          reason: { type: "string" },
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "substitutionProposalId", "idempotencyKey"],
      },
      execute: async (inv) => {
        try {
          await requireRun(inv);
          const proposalId = str(inv.args, "substitutionProposalId");
          if (inv.requestState === undefined) {
            const pending = await createSubstitutionEngine(db)
              .readPendingProposal(inv.principalUserId, proposalId);
            const choices = pending.candidates.map((candidate) => candidate.slug);
            return await makeConfirmation(
              "health_apply_substitution",
              proposalId,
              inv,
              "请选择要应用的替代动作；系统只会转移原动作尚未完成的组数。",
              [],
              {
                substitutionProposalId: proposalId,
                candidateSlugs: choices,
                reason: optStr(inv.args, "reason") ?? "mcp substitution",
              },
              {
                substitution_choice: {
                  method: "elicitation/create",
                  params: {
                    mode: "form",
                    message: "请选择一个替代动作",
                    requestedSchema: {
                      type: "object",
                      properties: { choice: { type: "string", enum: choices } },
                      required: ["choice"],
                    },
                  },
                },
              },
            );
          }
          const result = await requestStates.consume(
            inv.requestState,
            pendingBinding("health_apply_substitution", proposalId, inv),
            async (tx, pending) => {
              const payload = pending.payloadJson as {
                candidateSlugs?: unknown;
                reason?: unknown;
              };
              const candidateSlugs = Array.isArray(payload.candidateSlugs)
                ? payload.candidateSlugs.filter((value): value is string => typeof value === "string")
                : [];
              const chosenSlug = acceptedSelections(inv.inputResponses)["substitution_choice"];
              if (!chosenSlug || !candidateSlugs.includes(chosenSlug)) {
                throw new RangeError("substitution_choice must accept one offered candidate");
              }
              return writes.executeInTransaction(
                tx,
                writeInput(inv, "health_apply_substitution", proposalId),
                async (writeTx) => {
                  const applied = await createSubstitutionEngine(writeTx as unknown as Db).apply({
                    userId: inv.principalUserId,
                    substitutionProposalId: proposalId,
                    chosenSlug,
                    reason: typeof payload.reason === "string" ? payload.reason : "mcp substitution",
                  });
                  const [replacement] = await writeTx.select({
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
                  const outbox = await writeTx.select({ id: schema.outboxEvents.id })
                    .from(schema.outboxEvents)
                    .where(and(
                      eq(schema.outboxEvents.userId, inv.principalUserId),
                      eq(schema.outboxEvents.aggregateId, applied.replacementId),
                    ));
                  if (!replacement || outbox.length === 0) {
                    throw new Error("substitution apply read-back failed");
                  }
                  return {
                    response: {
                      replacementId: replacement.id,
                      trainingSessionId: replacement.sessionId,
                      chosenSlug,
                    },
                    factRefs: [{ type: "training_substitution", id: replacement.id }],
                    outboxEventIds: outbox.map((event) => event.id),
                  };
                },
              );
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
          changes: { type: "array", minItems: 1, items: PLAN_CHANGE_SCHEMA },
          reason: { type: "string" },
          previousVersionProblems: { type: "array", items: { type: "string" }, maxItems: 20 },
          validationQuestions: { type: "array", items: { type: "string" }, maxItems: 20 },
          idempotencyKey: { type: "string" },
        },
        required: ["runHandle", "reflectionId", "changes", "reason", "idempotencyKey"],
      },
      execute: async (inv) => {
        const reflectionId = str(inv.args, "reflectionId");
        const changes = inv.args["changes"];
        if (!Array.isArray(changes) || changes.length === 0) {
          throw new RangeError("changes must contain at least one material plan change");
        }
        const result = await writes.execute(
          writeInput(inv, "health_propose_plan_change", reflectionId),
          async (tx) => {
            const proposed = await createReflectionEngine(tx as unknown as Db).proposeChildVersion({
              userId: inv.principalUserId,
              reflectionId,
              changes: changes as Array<Record<string, unknown>>,
              reason: str(inv.args, "reason"),
              ...(Array.isArray(inv.args["previousVersionProblems"])
                ? { previousVersionProblems: inv.args["previousVersionProblems"] as string[] } : {}),
              ...(Array.isArray(inv.args["validationQuestions"])
                ? { validationQuestions: inv.args["validationQuestions"] as string[] } : {}),
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
              payloadJson: {
                observedOn: await today(inv.principalUserId),
                reflectionId,
              },
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
        await requireRun(inv);
        const planVersionId = str(inv.args, "planVersionId");
        if (inv.requestState === undefined) {
          const preview = await createReflectionEngine(db).previewActivation(
            inv.principalUserId,
            planVersionId,
            await today(inv.principalUserId),
          );
          if (!preview.governanceReview.allowed) {
            return toolError("health_safety_block", preview.governanceReview.reasons.join("; "));
          }
          return await makeConfirmation(
            "health_activate_plan_version", planVersionId, inv,
            `训练计划切换 ${preview.direction}: `
              + `v${preview.currentVersionNumber} → v${preview.targetVersionNumber}。`
              + `确定性审查：${JSON.stringify({ reviewer: preview.governanceReview.reviewedBy, reasons: preview.governanceReview.reasons })}。`
              + `完整变更：${JSON.stringify(preview.governanceReview.diff)}。`
              + `回滚目标：${preview.governanceReview.rollbackTargetVersionId}。`
              + `验证问题：${JSON.stringify(preview.governanceReview.validationQuestions)}。确认激活？`,
            ["确认激活", "暂不激活"],
            {
              planVersionId,
              currentVersionId: preview.currentVersionId,
              direction: preview.direction,
              deterministicReview: preview.governanceReview,
              diff: preview.governanceReview.diff,
              rollbackTargetVersionId: preview.governanceReview.rollbackTargetVersionId,
              validationQuestions: preview.governanceReview.validationQuestions,
            },
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
                let activation: PlanActivationResult | undefined;
                const effectiveFrom = await today(inv.principalUserId);
                if (confirmed) {
                  activation = await createReflectionEngine(writeTx as unknown as Db)
                    .activateVersion(inv.principalUserId, planVersionId, effectiveFrom);
                }
                const [decision] = await writeTx.insert(schema.userDecisionEvents).values({
                  userId: inv.principalUserId,
                  decisionType: confirmed ? "accepted" : "rejected",
                  subjectJson: {
                    type: "plan_activation",
                    planVersionId,
                    direction: activation?.direction ?? "declined",
                    previousVersionId: activation?.previousVersionId ?? null,
                  },
                }).returning();
                if (!decision) throw new Error("plan activation decision insert failed");
                const outboxEventIds = confirmed
                  ? activation!.outboxEventIds
                  : (await writeTx.insert(schema.outboxEvents).values({
                      userId: inv.principalUserId,
                      aggregateType: "user_decision",
                      aggregateId: decision.id,
                      eventType: "plan.activation_declined",
                      payloadJson: {
                        observedOn: effectiveFrom,
                        planVersionId,
                        direction: "declined",
                        previousVersionId: null,
                      },
                    }).returning({ id: schema.outboxEvents.id })).map((event) => event.id);
                const [readBack] = await writeTx.select().from(schema.planVersions)
                  .where(and(
                    eq(schema.planVersions.id, planVersionId),
                    eq(schema.planVersions.userId, inv.principalUserId),
                  )).limit(1);
                if (outboxEventIds.length === 0 || !readBack) throw new Error("plan activation read-back failed");
                return {
                  response: confirmed
                    ? {
                        planVersionId,
                        activated: true,
                        status: readBack.status,
                        direction: activation!.direction,
                        previousVersionId: activation!.previousVersionId,
                      }
                    : { planVersionId, activated: false, declined: true },
                  factRefs: confirmed
                    ? [{ type: "plan_version", id: readBack.id }, { type: "user_decision", id: decision.id }]
                    : [{ type: "user_decision", id: decision.id }],
                  outboxEventIds,
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
        return toolError("tool_not_found", `unknown tool: ${name}`);
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
        if (error instanceof TrainingSafetyBlockError) {
          return toolError(error.code, error.message);
        }
        if (error instanceof PlanActivationBlockedError || error instanceof ProposalConflictError) {
          return toolError(error.code, error.message);
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
        if (error instanceof SubstitutionProposalError) {
          return toolError("proposal_stale", error.reason);
        }
        if (error instanceof ProjectionReplayError) {
          return toolError("domain_unavailable", error.message);
        }
        if (error instanceof WriteCommandError) {
          return toolError(error.code, error.message);
        }
        return toolError("internal", "internal error");
      }
    },
  };
}
