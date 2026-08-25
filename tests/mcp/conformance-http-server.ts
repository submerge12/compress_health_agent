import { createServer } from "node:http";

import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { eq } from "drizzle-orm";

import { initToolContext } from "../../src/tools/context.js";
import { createHealthMcpServer } from "../../src/mcp/server-core.js";
import * as schema from "../../src/db/schema.js";

const databaseUrl = process.env.DATABASE_URL
  ?? "postgres://compass:compass@localhost:5433/compass_health";
const externalUserId = process.env.COMPASS_HEALTH_USER_BINDING
  ?? `mcp-conformance-${process.pid}`;

const ctx = await initToolContext({
  databaseUrl,
  externalUserId,
  locale: "zh",
  timezone: "Asia/Shanghai",
});
if (!ctx.db) throw new Error("database-backed context required");

const handler = createMcpHandler(() => createHealthMcpServer({
  db: ctx.db!,
  repo: ctx.repo,
  toolContext: ctx,
  externalUserId,
  actor: "codex-conformance",
  conformanceProfile: true,
}), { legacy: "reject" });
const server = createServer(toNodeHandler(handler));

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("HTTP server address unavailable");
process.stdout.write(`MCP_CONFORMANCE_URL=http://127.0.0.1:${address.port}/mcp\n`);

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await handler.close();
  if (ctx.db) {
    await ctx.db.delete(schema.outboxEvents).where(eq(schema.outboxEvents.userId, ctx.userId));
    await ctx.db.delete(schema.interactionEvents).where(eq(schema.interactionEvents.userId, ctx.userId));
    await ctx.db.delete(schema.users).where(eq(schema.users.id, ctx.userId));
  }
  await ctx.close();
}

process.on("SIGINT", () => void close().then(() => process.exit(0)));
process.on("SIGTERM", () => void close().then(() => process.exit(0)));
