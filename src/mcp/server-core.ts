/**
 * P1: MCP server core.
 *
 * Assembles the official v2 SDK Server with:
 * - protocol support pinned to 2026-07-28;
 * - SDK-owned `server/discover` and result wire codecs;
 * - tools/list + resources/list + resources/read backed by the catalogs;
 * - every handler resolving the principal from the transport-verified
 *   binding — tool arguments can never change identity.
 *
 * Write tools arrive in P2 (WO-MCP-3); P1 ships read-only surface only.
 */
import {
  acceptedContent,
  inputRequired,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type InputRequests,
  type Resource,
  type ResourceTemplateType,
  type Tool,
} from "@modelcontextprotocol/server";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema.js";
import type { Repository } from "../db/repository.js";
import type { ToolContext } from "../tools/context.js";
import type { MediaStreamUrlIssuer } from "../media/signed-stream-url.js";

import { CACHE_TTL_MS, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./server-info.js";
import { McpProtocolError } from "./errors.js";
import {
  createPrincipalResolver,
  verifiedActor,
  type ActorBindingOptions,
  type Principal,
} from "./auth/principal-resolver.js";
import { createResourceCatalog } from "./resources/catalog.js";
import { createHealthToolCatalog, type ToolOutcome } from "./tools/catalog.js";
import { createRunHandleService, RunHandleError } from "./evidence/run-handles.js";
import { createRequestStateService } from "./input/request-state.js";

type Db = PostgresJsDatabase<typeof schema>;

export interface CreateHealthMcpServerOptions extends ActorBindingOptions {
  db: Db;
  repo: Repository;
  toolContext: ToolContext;
  /** Injectable clock for deterministic boundary tests. */
  now?: () => Date;
  /** Test-only official conformance diagnostics; never enabled by stdio. */
  conformanceProfile?: boolean;
  /** Signed stream URL issuer supplied by the headless media runtime. */
  mediaStreamUrlIssuer?: MediaStreamUrlIssuer | null;
}

export function createHealthMcpServer(options: CreateHealthMcpServerOptions): Server {
  const { db, repo } = options;
  const principalResolver = createPrincipalResolver(db, {
    ...options,
    expectedUserId: options.toolContext.userId,
  });
  const resources = createResourceCatalog(db, repo, { now: options.now });
  const runs = createRunHandleService(db);
  const requestStates = createRequestStateService(db);
  const configuredActor = verifiedActor(options);

  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: {
        resources: { listChanged: false },
        tools: { listChanged: false },
      },
      instructions:
        "Compass Health domain server. Read daily-state and active constraints BEFORE any training advice. " +
        "All state crosses calls via explicit handles (runHandle, trainingProposalId, …) — there are no sessions.",
      enforceStrictCapabilities: false,
      supportedProtocolVersions: [...SUPPORTED_LIST],
      cacheHints: {
        "server/discover": { ttlMs: CACHE_TTL_MS.systemCapabilities, cacheScope: "public" },
        "tools/list": { ttlMs: CACHE_TTL_MS.toolCatalog, cacheScope: "public" },
        "resources/list": { ttlMs: CACHE_TTL_MS.resourceCatalog, cacheScope: "public" },
        "resources/templates/list": { ttlMs: CACHE_TTL_MS.resourceCatalog, cacheScope: "public" },
        "resources/read": { ttlMs: 0, cacheScope: "private" },
      },
      requestState: {
        verify: (state) => options.conformanceProfile && state === "conformance-state-v1"
          ? state
          : requestStates.verify(state, {
              userId: options.toolContext.userId,
              verifiedActor: configuredActor,
            }),
      },
    },
  );

  // ── resources/list ──
  server.setRequestHandler("resources/list", async (request) => {
    const principal = await resolveFromRequest(principalResolver, request);
    const list = await resources.listResources(principal);
    return { resources: list as Resource[] };
  });

  // ── resources/read ──
  server.setRequestHandler("resources/read", async (request) => {
    const principal = await resolveFromRequest(principalResolver, request);
    const uri = String((request.params as { uri?: unknown }).uri ?? "");
    const meta = request.params?._meta as Record<string, unknown> | undefined;
    const suppliedRun = meta?.["compass.health/runHandle"];
    let runHandle = typeof suppliedRun === "string" && suppliedRun !== "" ? suppliedRun : undefined;
    let implicitRun = false;
    if (!runHandle) {
      const begun = await runs.beginRun({
        userId: principal.userId,
        objective: `resource read ${uri}`,
        inputChannel: "mcp-resource",
        actor: principal.actor,
        actorId: principal.actorId,
        actorProfile: principal.actorProfile,
      });
      runHandle = begun.runHandle;
      implicitRun = true;
    }
    try {
      let result: Awaited<ReturnType<typeof resources.readResource>>;
      try {
        result = await resources.readResource(principal, uri);
      } catch (error) {
        if (error instanceof McpProtocolError && error.code === "not_found") {
          throw ProtocolError.fromError(
            ProtocolErrorCode.InvalidParams,
            error.message,
            { uri },
          );
        }
        throw error;
      }
      await runs.recordStep({
        userId: principal.userId,
        runHandle,
        actorId: principal.actorId,
        stage: "resource_read",
        mcpMethod: "resources/read",
        resourceUri: uri,
        aggregateType: result.evidence.aggregateType,
        aggregateId: result.evidence.aggregateId,
        stateRevisionAfter: result.evidence.stateRevision,
        resultSummary: result.evidence.resultSummary,
      });
      if (implicitRun) {
        await runs.endRun({ userId: principal.userId, runHandle, outcome: "completed" });
      }
      return {
        contents: result.contents,
        _meta: {
          ...result._meta,
          "compass.health/runHandle": runHandle,
          "compass.health/evidence": {
            aggregateType: result.evidence.aggregateType,
            aggregateId: result.evidence.aggregateId,
            ...(result.evidence.stateRevision !== undefined
              ? { stateRevision: result.evidence.stateRevision }
              : {}),
          },
        },
      };
    } catch (error) {
      if (error instanceof RunHandleError) {
        throw ProtocolError.fromError(
          ProtocolErrorCode.InvalidParams,
          error.message,
          { reason: error.reason },
        );
      }
      try {
        await runs.recordStep({
          userId: principal.userId,
          runHandle,
          stage: "resource_read",
          mcpMethod: "resources/read",
          resourceUri: uri,
          status: "failed",
          errorCode: error instanceof McpProtocolError ? error.code : "internal",
        });
      } catch (recordError) {
        if (recordError instanceof RunHandleError) {
          throw ProtocolError.fromError(
            ProtocolErrorCode.InvalidParams,
            recordError.message,
            { reason: recordError.reason },
          );
        }
        throw recordError;
      }
      if (implicitRun) {
        await runs.endRun({ userId: principal.userId, runHandle, outcome: "failed" });
      }
      throw error;
    }
  });

  // Dynamic resources are advertised through the protocol's formal template
  // operation. Curly-braced URIs must never appear as directly readable
  // entries in resources/list.
  server.setRequestHandler("resources/templates/list", async (request) => {
    const principal = await resolveFromRequest(principalResolver, request);
    const list = await resources.listResourceTemplates(principal);
    return { resourceTemplates: list as ResourceTemplateType[] };
  });

  // ── tools/list: P1 read tool + P2 canonical write tools ──
  const tools = createHealthToolCatalog(db, repo, {
    toolContext: options.toolContext,
    conformanceProfile: options.conformanceProfile,
    now: options.now,
    ...(options.mediaStreamUrlIssuer !== undefined
      ? { mediaStreamUrlIssuer: options.mediaStreamUrlIssuer }
      : {}),
  });
  server.setRequestHandler("tools/list", async () => {
    return {
      tools: [
        {
          name: "health_get_system_status",
          description: "Server + database liveness for the health system.",
          inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
          _meta: { "compass.health/risk": "read-only" },
        },
        ...tools.listTools(),
      ] as Tool[],
    };
  });

  // tools/call: dispatch to the catalog; MRTR results pass through with
  // resultType input_required.
  server.setRequestHandler(
    "tools/call",
    async (request, ctx) => {
      const params = request.params;
      const principal = await resolveFromRequest(principalResolver, request);
      if (params.name === "health_get_system_status") {
        // Liveness probe: a trivial query proves the DB path end to end.
        await db.execute(sql`SELECT 1`);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ status: "ok", server: MCP_SERVER_NAME, version: MCP_SERVER_VERSION, actor: principal.actor }),
          }],
        };
      }
      const requestState = ctx.mcpReq.requestState<string>();
      const args = params.arguments ?? {};
      const runHandle = stringArgument(args, "runHandle");
      const attemptTracked = runHandle === undefined
        ? false
        : await recordToolAttempt(runs, principal, runHandle, params.name, args);
      const confirmation = acceptedContent<{ choice?: string }>(
        ctx.mcpReq.inputResponses,
        "confirmation",
      );
      let outcome: ToolOutcome;
      try {
        outcome = await tools.call(params.name, {
          principalUserId: principal.userId,
          actor: principal.actor,
          actorId: principal.actorId,
          actorProfile: principal.actorProfile,
          args,
          ...(typeof requestState === "string" ? { requestState } : {}),
          ...(confirmation?.choice ? { confirmationChoice: confirmation.choice } : {}),
          ...(ctx.mcpReq.inputResponses ? {
            inputResponses: ctx.mcpReq.inputResponses as Record<string, unknown>,
          } : {}),
        });
      } catch (error) {
        if (attemptTracked && runHandle !== undefined) {
          await runs.recordStep({
            userId: principal.userId,
            runHandle,
            actorId: principal.actorId,
            stage: "tool_result",
            mcpMethod: "tools/call",
            mcpName: params.name,
            status: "failed",
            errorCode: "internal",
            failureStage: "dispatch",
            resultSummary: { resultType: "complete", errorCode: "internal" },
          });
        }
        throw error;
      }
      if (attemptTracked && runHandle !== undefined) {
        const terminal = terminalEvidence(params.name, outcome);
        await runs.recordStep({
          userId: principal.userId,
          runHandle,
          actorId: principal.actorId,
          stage: "tool_result",
          mcpMethod: "tools/call",
          mcpName: params.name,
          status: terminal.status,
          ...(terminal.errorCode ? { errorCode: terminal.errorCode } : {}),
          ...(terminal.failureStage ? { failureStage: terminal.failureStage } : {}),
          allowClosed: params.name === "health_end_run",
          resultSummary: {
            resultType: outcome.resultType,
            ...(terminal.errorCode ? { errorCode: terminal.errorCode } : {}),
            ...(typeof outcome.structured?.["receiptId"] === "string"
              ? { receiptId: outcome.structured["receiptId"] } : {}),
          },
        });
      }
      if (outcome.resultType === "input_required") {
        const pending = outcome.structured as {
          requestState?: string;
          inputRequests?: Record<string, unknown>;
        } | undefined;
        if (!pending?.inputRequests) {
          throw new McpProtocolError("internal", "input_required outcome has no input requests");
        }
        return inputRequired({
          inputRequests: pending.inputRequests as InputRequests,
          ...(pending.requestState ? { requestState: pending.requestState } : {}),
        });
      }
      return {
        isError: outcome.isError === true ? true : undefined,
        content: outcome.content,
        structuredContent: outcome.structured,
      };
    },
  );

  return server;
}

async function recordToolAttempt(
  runs: ReturnType<typeof createRunHandleService>,
  principal: Principal,
  runHandle: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  try {
    await runs.recordStep({
      userId: principal.userId,
      runHandle,
      actorId: principal.actorId,
      stage: "tool_attempt",
      mcpMethod: "tools/call",
      mcpName: toolName,
      arguments: args,
    });
    return true;
  } catch (error) {
    if (error instanceof RunHandleError) return false;
    throw error;
  }
}

function terminalEvidence(toolName: string, outcome: ToolOutcome): {
  status: "ok" | "failed" | "refused" | "input_required";
  errorCode?: string;
  failureStage?: string;
} {
  if (outcome.resultType === "input_required") return { status: "input_required" };
  if (outcome.isError !== true) return { status: "ok" };
  const errorCode = typeof outcome.structured?.["error"] === "string"
    ? outcome.structured["error"]
    : "internal";
  const refused = new Set([
    "actor_mismatch",
    "health_safety_block",
    "not_found",
    "not_owned",
    "proposal_stale",
    "run_handle_invalid",
    "state_conflict",
    "unauthorized_actor",
  ]).has(errorCode);
  return {
    status: refused ? "refused" : "failed",
    errorCode,
    failureStage: failureStageFor(toolName, errorCode),
  };
}

function failureStageFor(toolName: string, errorCode: string): string {
  if (errorCode === "tool_not_found") return "tool_lookup";
  if (["actor_mismatch", "not_owned", "run_handle_invalid", "unauthorized_actor"].includes(errorCode)) {
    return "authorization";
  }
  if (errorCode === "not_found") return "target_lookup";
  if (["proposal_stale", "state_conflict", "idempotency_conflict", "invalid_session_state"].includes(errorCode)) {
    return "precondition";
  }
  if (errorCode === "health_safety_block") return "safety";
  if (errorCode === "domain_unavailable" && toolName === "health_replay_projection") return "projection";
  if (errorCode === "validation_failed") return "validation";
  return "execution";
}

function stringArgument(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

const SUPPORTED_LIST = ["2026-07-28"];

async function resolveFromRequest(
  resolver: { resolvePrincipal: (meta: Record<string, unknown> | undefined) => Promise<Principal> },
  request: unknown,
): Promise<Principal> {
  const meta = (request as { params?: { _meta?: Record<string, unknown> } }).params?._meta;
  return resolver.resolvePrincipal(meta);
}
