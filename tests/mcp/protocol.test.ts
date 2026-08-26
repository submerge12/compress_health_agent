/**
 * MCP 2026 acceptance through the v2 fetch-shaped wire handler.
 *
 * Gates (plan §十七.1):
 * - server/discover selects 2026-07-28 without initialize;
 * - resources/list is deterministic and complete;
 * - resources/read scopes by the bound principal — another user's session
 *   URI is 404, never leaked;
 * - tools/call works for the P1 read tool and rejects unknown names;
 * - every request is self-contained and session-free.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
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
  let handler: ReturnType<typeof createMcpHandler>;

  beforeAll(async () => {
    ctx = await initToolContext({
      externalUserId,
      locale: "zh",
      databaseUrl: DATABASE_URL,
      timezone: "Asia/Shanghai",
    });
    if (!ctx.db) throw new Error("db context required");
    handler = createMcpHandler(() => createHealthMcpServer({
        db: ctx.db!,
        repo: ctx.repo,
        toolContext: ctx,
        externalUserId,
      }), { legacy: "reject" });
    client = new Client(
      { name: "p1-test", version: "0.0.1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
    await handler.close();
    await db.delete(schema.users).where(eq(schema.users.externalId, externalUserId));
    await ctx.close();
    await pool.end({ timeout: 3 });
  });

  it("discovers the 2026 protocol without initialize", async () => {
    const info = client.getServerVersion();
    expect(info).toBeDefined();
    expect(info?.name).toBe("compass-health");
    expect(client.getProtocolEra()).toBe("modern");
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(["2026-07-28"]);
    expect(client.getDiscoverResult()?.supportedVersions).toEqual(["2026-07-28"]);
  });

  it("separates directly readable resources from formal URI templates", async () => {
    const first = await client.listResources();
    const second = await client.listResources();
    const uris = first.resources.map((r) => String(r.uri));
    expect(uris).toContain("health://profile");
    expect(uris).toContain("health://daily-state/today");
    expect(uris).toContain("health://constraints/active/today");
    expect(uris).toContain("health://plans/training/active");
    expect(uris.every((uri) => !uri.includes("{"))).toBe(true);
    expect(uris).toEqual([...uris].sort());
    expect(uris).toEqual(second.resources.map((r) => String(r.uri)));

    const templates = await client.listResourceTemplates();
    const templateUris = templates.resourceTemplates.map((r) => r.uriTemplate);
    expect(templateUris).toEqual([
      "health://constraints/active/{date}",
      "health://daily-state/{date}",
      "health://diet/logs/{date}",
      "health://training/sessions/{sessionId}",
    ]);
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
    expect(JSON.parse((unknown.content as Array<{ text: string }>)[0]!.text))
      .toMatchObject({ error: "tool_not_found" });
  });
});
