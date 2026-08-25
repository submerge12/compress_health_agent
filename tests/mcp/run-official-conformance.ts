import { spawn } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import postgres from "postgres";

const tsxCli = resolve("node_modules", "tsx", "dist", "cli.mjs");
const binding = `mcp-official-conformance-${process.pid}`;
const server = spawn(process.execPath, [tsxCli, "tests/mcp/conformance-http-server.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "test",
    COMPASS_HEALTH_USER_BINDING: binding,
  },
  stdio: ["ignore", "pipe", "inherit"],
  windowsHide: true,
});

const url = await new Promise<string>((resolveUrl, reject) => {
  const timeout = setTimeout(() => reject(new Error("conformance HTTP server startup timed out")), 15_000);
  server.once("exit", (code) => reject(new Error(`conformance HTTP server exited early (${code})`)));
  createInterface({ input: server.stdout }).on("line", (line) => {
    if (!line.startsWith("MCP_CONFORMANCE_URL=")) return;
    clearTimeout(timeout);
    resolveUrl(line.slice("MCP_CONFORMANCE_URL=".length));
  });
});

const outputDir = resolve(
  ".codex-test-tmp",
  `official-mcp-conformance-${process.pid}-${Date.now()}`,
);
await mkdir(outputDir, { recursive: true });
const runner = resolve("node_modules", "@modelcontextprotocol", "conformance", "dist", "index.js");
const scenarios = [
  "server-stateless",
  "tools-list",
  "input-required-result-request-state",
  "sep-2164-resource-not-found",
  "http-header-validation",
];
let result = 0;
for (const scenario of scenarios) {
  result = await new Promise<number>((resolveExit, reject) => {
    const child = spawn(process.execPath, [
      runner,
      "server",
      "--url", url,
      "--scenario", scenario,
      "--spec-version", "2026-07-28",
      "--force",
      "--output-dir", outputDir,
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  if (result === 3221226505 && process.platform === "win32"
      && await scenarioChecksPassed(outputDir, scenario)) {
    process.stderr.write(`conformance runner hit known Windows libuv close assertion after ${scenario}; checks.json is clean\n`);
    result = 0;
  }
  if (result !== 0) break;
}

server.kill();
const databaseUrl = process.env.DATABASE_URL
  ?? "postgres://compass:compass@localhost:5433/compass_health";
const cleanup = postgres(databaseUrl, { max: 1, prepare: false });
try {
  const [user] = await cleanup`SELECT id FROM compass_health.users WHERE external_id = ${binding}`;
  if (user) {
    await cleanup`DELETE FROM compass_health.outbox_events WHERE user_id = ${user.id}::uuid`;
    await cleanup`DELETE FROM compass_health.interaction_events WHERE user_id = ${user.id}::uuid`;
    await cleanup`DELETE FROM compass_health.users WHERE id = ${user.id}::uuid`;
  }
} finally {
  await cleanup.end({ timeout: 3 });
}
if (result !== 0) process.exit(result);
process.stdout.write(`official MCP 2026-07-28 conformance: PASS (${scenarios.length} scenarios; ${outputDir})\n`);

async function scenarioChecksPassed(root: string, scenario: string): Promise<boolean> {
  const entries = await readdir(root, { withFileTypes: true });
  const directory = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`server-${scenario}-`))
    .map((entry) => entry.name)
    .sort()
    .at(-1);
  if (!directory) return false;
  const checks = JSON.parse(await readFile(resolve(root, directory, "checks.json"), "utf8")) as Array<{
    status?: string;
  }>;
  return checks.length > 0 && checks.every((check) =>
    check.status === "SUCCESS" || check.status === "SKIPPED" || check.status === "INFO");
}
