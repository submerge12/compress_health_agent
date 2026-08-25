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
  type Tool,
} from "@modelcontextprotocol/server";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema.js";
import type { Repository } from "../db/repository.js";
import type { ToolContext } from "../tools/context.js";

import { CACHE_TTL_MS, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./server-info.js";
import { McpProtocolError } from "./errors.js";
import { createPrincipalResolver, type ActorBindingOptions, type Principal } from "./auth/principal-resolver.js";
import { createResourceCatalog } from "./resources/catalog.js";
import { createHealthToolCatalog } from "./tools/catalog.js";
import { createRunHandleService } from "./evidence/run-handles.js";
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
  const verifiedActor = options.actor?.trim() || "codex-primary";

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
        "resources/read": { ttlMs: 0, cacheScope: "private" },
      },
      requestState: {
        verify: (state) => options.conformanceProfile && state === "conformance-state-v1"
          ? state
          : requestStates.verify(state, {
              userId: options.toolContext.userId,
              verifiedActor,
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
        stage: "resource_read",
        mcpMethod: "resources/read",
        resourceUri: uri,
        resultSummary: { contentCount: result.contents.length },
      });
      if (implicitRun) {
        await runs.endRun({ userId: principal.userId, runHandle, outcome: "completed" });
      }
      return {
        contents: result.contents,
        _meta: { ...result._meta, "compass.health/runHandle": runHandle },
      };
    } catch (error) {
      await runs.recordStep({
        userId: principal.userId,
        runHandle,
        stage: "resource_read",
        mcpMethod: "resources/read",
        resourceUri: uri,
        status: "failed",
        errorCode: error instanceof McpProtocolError ? error.code : "internal",
      });
      if (implicitRun) {
        await runs.endRun({ userId: principal.userId, runHandle, outcome: "failed" });
      }
      throw error;
    }
  });

  // ── tools/list: P1 read tool + P2 canonical write tools ──
  const tools = createHealthToolCatalog(db, repo, {
    toolContext: options.toolContext,
    conformanceProfile: options.conformanceProfile,
    now: options.now,
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
      const confirmation = acceptedContent<{ choice?: string }>(
        ctx.mcpReq.inputResponses,
        "confirmation",
      );
      const outcome = await tools.call(params.name, {
        principalUserId: principal.userId,
        actor: principal.actor,
        args: params.arguments ?? {},
        ...(typeof requestState === "string" ? { requestState } : {}),
        ...(confirmation?.choice ? { confirmationChoice: confirmation.choice } : {}),
        ...(ctx.mcpReq.inputResponses ? {
          inputResponses: ctx.mcpReq.inputResponses as Record<string, unknown>,
        } : {}),
      });
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

const SUPPORTED_LIST = ["2026-07-28"];

async function resolveFromRequest(
  resolver: { resolvePrincipal: (meta: Record<string, unknown> | undefined) => Promise<Principal> },
  request: unknown,
): Promise<Principal> {
  const meta = (request as { params?: { _meta?: Record<string, unknown> } }).params?._meta;
  return resolver.resolvePrincipal(meta);
}
