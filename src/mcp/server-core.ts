/**
 * P1: MCP server core.
 *
 * Assembles the official-SDK Server with:
 * - initialize negotiation restricted to SUPPORTED_PROTOCOL_VERSIONS;
 * - a custom `server/discover` handler (2026-07-28 self-description: the
 *   SDK does not ship it yet, so it is registered as a raw protocol handler);
 * - tools/list + resources/list + resources/read backed by the catalogs;
 * - every handler resolving the principal from the transport-verified
 *   binding — tool arguments can never change identity.
 *
 * Write tools arrive in P2 (WO-MCP-3); P1 ships read-only surface only.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod/v4";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema.js";
import type { Repository } from "../db/repository.js";

import { MCP_SERVER_NAME, MCP_SERVER_VERSION, serverCapabilitiesDocument } from "./server-info.js";
import { McpProtocolError, JSON_RPC } from "./errors.js";
import { createPrincipalResolver, type ActorBindingOptions, type Principal } from "./auth/principal-resolver.js";
import { createResourceCatalog } from "./resources/catalog.js";
import { createHealthToolCatalog } from "./tools/catalog.js";

type Db = PostgresJsDatabase<typeof schema>;

export interface CreateHealthMcpServerOptions extends ActorBindingOptions {
  db: Db;
  repo: Repository;
}

export function createHealthMcpServer(options: CreateHealthMcpServerOptions): Server {
  const { db, repo } = options;
  const principalResolver = createPrincipalResolver(db, options);
  const resources = createResourceCatalog(db, repo);

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
    },
  );

  // ── 2026-07-28: server/discover (self-description; SDK lacks it yet) ──
  server.setRequestHandler(
    z.object({
      method: z.literal("server/discover"),
      params: z.object({
        protocolVersion: z.string().optional(),
        _meta: z.looseObject({}).optional(),
      }).optional(),
    }),
    (request) => {
      const requested = request.params?.protocolVersion;
      if (requested !== undefined && !(serverCapabilitiesDocument().server.protocolVersions as readonly string[]).includes(requested)) {
        throw new McpProtocolError(
          "protocol_version_mismatch",
          `protocol version ${requested} not supported; supported: ${SUPPORTED_LIST}`,
          JSON_RPC.INVALID_REQUEST,
        );
      }
      return {
        protocolVersion: requested ?? SUPPORTED_LIST[0],
        ...serverCapabilitiesDocument(),
      };
    },
  );

  // ── resources/list ──
  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const principal = await resolveFromRequest(principalResolver, request);
    const list = await resources.listResources(principal);
    return { resources: list };
  });

  // ── resources/read ──
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const principal = await resolveFromRequest(principalResolver, request);
    const uri = String((request.params as { uri?: unknown }).uri ?? "");
    const result = await resources.readResource(principal, uri);
    return { contents: result.contents, _meta: result._meta };
  });

  // ── tools/list: P1 read tool + P2 canonical write tools ──
  const tools = createHealthToolCatalog(db, repo);
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "health_get_system_status",
          description: "Server + database liveness for the health system.",
          inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
          _meta: { "compass.health/risk": "read-only" },
        },
        ...tools.listTools(),
      ],
    };
  });

  // tools/call: dispatch to the catalog; MRTR results pass through with
  // resultType input_required.
  server.setRequestHandler(
    z.object({
      method: z.literal("tools/call"),
      params: z.object({
        name: z.string(),
        arguments: z.looseObject({}).optional(),
        _meta: z.looseObject({}).optional(),
      }),
    }),
    async (request) => {
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
      const outcome = await tools.call(params.name, {
        principalUserId: principal.userId,
        actor: principal.actor,
        args: params.arguments ?? {},
      });
      return {
        ...(outcome.resultType === "input_required"
          ? { _meta: { "compass.health/resultType": "input_required" } } : {}),
        isError: outcome.isError === true ? true : undefined,
        content: outcome.content,
      };
    },
  );

  return server;
}

const SUPPORTED_LIST = ["2025-11-25", "2025-06-18"];

async function resolveFromRequest(
  resolver: { resolvePrincipal: (meta: Record<string, unknown> | undefined) => Promise<Principal> },
  request: unknown,
): Promise<Principal> {
  const meta = (request as { params?: { _meta?: Record<string, unknown> } }).params?._meta;
  return resolver.resolvePrincipal(meta);
}

export async function connectHealthMcpServer(server: Server, transport: Transport): Promise<void> {
  await server.connect(transport);
}
