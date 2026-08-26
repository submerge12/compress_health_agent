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
 * - COMPASS_HEALTH_ACTOR_TYPE / RUNTIME_NAME / RUNTIME_VERSION
 * - COMPASS_HEALTH_AGENT_PROFILE / AGENT_PROFILE_VERSION
 * - COMPASS_HEALTH_MODEL_PROVIDER / MODEL_NAME
 *                                     (optional) formal Actor Profile fields
 * - COMPASS_HEALTH_ALLOW_USER_PROVISIONING (optional) explicit opt-in; default false
 *
 * MCP traffic remains STDIO-only. In embedded media mode a separate,
 * signed-URL server listens on loopback solely for bounded video bytes.
 */
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";

import { initToolContext } from "../tools/context.js";
import { assertSchemaReady } from "../db/migrate.js";
import { startEmbeddedProjectionWorker } from "../domain/projection-worker-main.js";
import { startMediaRuntime, type MediaRuntimeMode } from "../media/runtime-server.js";
import { createHealthMcpServer } from "./server-core.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
    ?? "postgres://compass:compass@localhost:5433/compass_health";
  const externalUserId = process.env.COMPASS_HEALTH_USER_BINDING;
  const allowUserProvisioning = process.env.COMPASS_HEALTH_ALLOW_USER_PROVISIONING
    ?.trim().toLowerCase() === "true";

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
    allowUserProvisioning,
  });
  if (!ctx.db) {
    process.stderr.write("compass-health MCP: database-backed context is required\n");
    process.exit(2);
  }

  const projectionMode = process.env.COMPASS_HEALTH_PROJECTION_WORKER_MODE
    ?? (process.env.NODE_ENV === "test" ? "disabled" : "embedded");
  const projection = projectionMode === "embedded"
    ? startEmbeddedProjectionWorker({
        db: ctx.db,
        repo: ctx.repo,
        onlyUserId: ctx.userId,
        onError: (error) => process.stderr.write(
          `compass-health MCP projection worker: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      })
    : undefined;
  const now = testClock();
  const mediaMode = mediaRuntimeMode(process.env.COMPASS_HEALTH_MEDIA_RUNTIME);
  const media = await startMediaRuntime({
    db: ctx.db,
    mode: mediaMode,
    ...(process.env.COMPASS_HEALTH_MEDIA_BASE_URL
      ? { baseUrl: process.env.COMPASS_HEALTH_MEDIA_BASE_URL } : {}),
    ...(process.env.COMPASS_HEALTH_MEDIA_SIGNING_SECRET
      ? { signingSecret: process.env.COMPASS_HEALTH_MEDIA_SIGNING_SECRET } : {}),
  });

  let handle: StdioServerHandle | undefined;
  handle = serveStdio(() => createHealthMcpServer({
      db: ctx.db!,
      repo: ctx.repo,
      toolContext: ctx,
      externalUserId,
      actor: process.env.COMPASS_HEALTH_ACTOR,
      actorProfile: {
        actorType: process.env.COMPASS_HEALTH_ACTOR_TYPE,
        runtimeName: process.env.COMPASS_HEALTH_RUNTIME_NAME,
        runtimeVersion: process.env.COMPASS_HEALTH_RUNTIME_VERSION,
        agentProfile: process.env.COMPASS_HEALTH_AGENT_PROFILE,
        agentProfileVersion: process.env.COMPASS_HEALTH_AGENT_PROFILE_VERSION,
        modelProvider: process.env.COMPASS_HEALTH_MODEL_PROVIDER,
        modelName: process.env.COMPASS_HEALTH_MODEL_NAME,
      },
      mediaStreamUrlIssuer: media.issueStreamUrl,
      ...(now ? { now } : {}),
    }), {
      legacy: "reject",
      onerror: (error) => {
        process.stderr.write(`compass-health MCP: protocol error: ${error.message}\n`);
      },
    });
  process.stderr.write(
    `compass-health MCP: ready on stdio (binding=${externalUserId}, projection=${projectionMode}, media=${media.mode}${media.baseUrl ? `:${media.baseUrl}` : ""})\n`,
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await handle?.close();
    await projection?.stop();
    await media.stop();
    await ctx.close();
    process.exit(0);
  };
  process.stdin.once("end", () => void shutdown());
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function mediaRuntimeMode(value: string | undefined): MediaRuntimeMode {
  const mode = value?.trim().toLowerCase() || "embedded";
  if (mode === "embedded" || mode === "external" || mode === "off") return mode;
  throw new RangeError("COMPASS_HEALTH_MEDIA_RUNTIME must be embedded|external|off");
}

function testClock(): (() => Date) | undefined {
  const value = process.env.NODE_ENV === "test"
    ? process.env.COMPASS_HEALTH_TEST_NOW?.trim()
    : undefined;
  if (!value) return undefined;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError("COMPASS_HEALTH_TEST_NOW must be an ISO timestamp");
  }
  return () => new Date(instant.getTime());
}

main().catch((error: unknown) => {
  process.stderr.write(`compass-health MCP: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
