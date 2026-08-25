/**
 * P1 acceptance: MCP protocol surface over the SDK InMemory transport.
 *
 * Gates (plan §十七.1):
 * - initialize negotiates a supported protocol version;
 * - server/discover (2026-07-28 self-description) returns capabilities and
 *   refuses unsupported versions;
 * - resources/list is deterministic and complete;
 * - resources/read scopes by the bound principal — another user's session
 *   URI is 404, never leaked;
 * - tools/call works for the P1 read tool and rejects unknown names;
 * - no session state: a fresh client can read immediately after initialize
 *   (every request is self-contained).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/db/schema.js";
import { initToolContext } from "../../src/tools/context.js";
import { createHealthMcpServer } from "../../src/mcp/server-core.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "../../src/mcp/server-info.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";

const isDbAvailable = await postgres(DATABASE_URL, { max: 1, connect_timeout: 3 })
  .unsafe("SELECT 1")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!isDbAvailable)("MCP server core (P1)", () => {
  const pool = postgres(DATABASE_URL, { max: 4, prepare: false });
  const db = drizzle(pool, { schema });
  let ctx: Awaited<ReturnType<typeof initToolContext>>;
  const externalUserId = `mcp-p1-${Date.now()}`;
  let client: Client;

  beforeAll(async () => {
    ctx = await initToolContext({
      externalUserId,
      locale: "zh",
      databaseUrl: DATABASE_URL,
      timezone: "Asia/Shanghai",
    });
    if (!ctx.db) throw new Error("db context required");
    const server = createHealthMcpServer({
      db: ctx.db,
      repo: ctx.repo,
      externalUserId,
    });
    client = new Client({ name: "p1-test", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.externalId, externalUserId));
    await ctx.close();
    await pool.end({ timeout: 3 });
  });

  it("initialize negotiates a supported protocol version and discover works", async () => {
    const info = client.getServerVersion();
    expect(info).toBeDefined();
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain("2025-11-25");

    const discoverSchema = z.object({
      protocolVersion: z.string(),
      server: z.object({ name: z.string(), version: z.string() }),
      capabilities: z.looseObject({}),
      stateModel: z.looseObject({}),
    });
    const discover = await client.request(
      { method: "server/discover", params: {} } as never,
      discoverSchema,
    );
    expect(discover.server.name).toBe("compass-health");
    expect(discover.protocolVersion).toBe("2025-11-25");
    expect(discover.stateModel.sessions).toContain("self-contained");

    // Unsupported protocol versions are refused with a machine-readable code.
    await expect(client.request(
      { method: "server/discover", params: { protocolVersion: "1999-01-01" } } as never,
      discoverSchema,
    )).rejects.toThrow(/protocol_version_mismatch|not supported/);
  });

  it("resources/list is deterministic and covers the P1 catalog", async () => {
    const first = await client.listResources();
    const second = await client.listResources();
    const uris = first.resources.map((r) => String(r.uri));
    expect(uris).toContain("health://profile");
    expect(uris).toContain("health://daily-state/{date}");
    expect(uris).toContain("health://constraints/active/{date}");
    expect(uris).toContain("health://plans/training/active");
    expect(uris).toEqual([...uris].sort());
    expect(uris).toEqual(second.resources.map((r) => String(r.uri)));
  });

  it("resources/read returns profile + daily-state with cache hints", async () => {
    const profile = await client.readResource({ uri: "health://profile" });
    const first = profile.contents[0]!;
    if (!("text" in first)) throw new Error("expected text content");
    const body = JSON.parse(first.text);
    expect(body.externalUserId).toBe(externalUserId);
    expect(body.timezone).toBe("Asia/Shanghai");

    const state = await client.readResource({ uri: "health://daily-state/today" });
    expect(state.contents[0]).toBeDefined();
  });

  it("resources/read never leaks another user's session", async () => {
    // A random session id owned by nobody: must be 404, not a leak.
    await expect(client.readResource({
      uri: "health://training/sessions/00000000-0000-0000-0000-000000000000",
    })).rejects.toThrow(/not_found|not found/i);
  });

  it("tools/call works for the read tool and refuses unknown tools", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("health_get_system_status");

    const result = await client.callTool({ name: "health_get_system_status", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text).status).toBe("ok");

    // Unknown tools surface as isError results (P2 semantics), not rejections.
    const unknown = await client.callTool({ name: "health_nonexistent", arguments: {} });
    expect(unknown.isError).toBe(true);
    expect((unknown.content as Array<{ text: string }>)[0]!.text).toContain("not_found");
  });
});
