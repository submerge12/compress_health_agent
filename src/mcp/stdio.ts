/**
 * P1 / WO-MCP-2: STDIO transport entry for local Codex usage.
 *
 * Codex config (~/.codex/config.toml):
 *   [mcp_servers.compass_health]
 *   command = "node"
 *   args = ["G:/compress_health_agent/dist/mcp/stdio.js"]
 *   [mcp_servers.compass_health.env]
 *   COMPASS_HEALTH_USER_BINDING = "compass-health:1"
 *
 * Environment:
 * - DATABASE_URL                     (required) PostgreSQL DSN
 * - COMPASS_HEALTH_USER_BINDING      (required) external id of the single
 *                                     local user; no binding, no tools
 * - COMPASS_HEALTH_ACTOR             (optional) actor label, default codex-primary
 *
 * STDIO mode never listens on a port and never reads bearer tokens: the OS
 * user that launched the process IS the principal.
 */
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";

import { initToolContext } from "../tools/context.js";
import { assertSchemaReady } from "../db/migrate.js";
import { createHealthMcpServer } from "./server-core.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
    ?? "postgres://compass:compass@localhost:5433/compass_health";
  const externalUserId = process.env.COMPASS_HEALTH_USER_BINDING;

  if (!externalUserId) {
    // Fail loudly on stderr (stdout is the MCP channel) and exit — a server
    // without a user binding would silently act as nobody.
    process.stderr.write("compass-health MCP: COMPASS_HEALTH_USER_BINDING is required\n");
    process.exit(2);
  }

  await assertSchemaReady(databaseUrl);

  const ctx = await initToolContext({
    externalUserId,
    locale: "zh",
    databaseUrl,
    timezone: process.env.COMPASS_HEALTH_TIMEZONE ?? "Asia/Shanghai",
  });
  if (!ctx.db) {
    process.stderr.write("compass-health MCP: database-backed context is required\n");
    process.exit(2);
  }

  let handle: StdioServerHandle | undefined;
  handle = serveStdio(() => createHealthMcpServer({
      db: ctx.db!,
      repo: ctx.repo,
      toolContext: ctx,
      externalUserId,
      actor: process.env.COMPASS_HEALTH_ACTOR,
    }), {
      legacy: "reject",
      onerror: (error) => {
        process.stderr.write(`compass-health MCP: protocol error: ${error.message}\n`);
      },
    });
  process.stderr.write(`compass-health MCP: ready on stdio (binding=${externalUserId})\n`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await handle?.close();
    await ctx.close();
    process.exit(0);
  };
  process.stdin.once("end", () => void shutdown());
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`compass-health MCP: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
