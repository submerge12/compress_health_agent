import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";
const PROTOCOL_VERSION = "2026-07-28";
const externalUserId = `mcp-wire-${process.pid}-${Date.now()}`;
const testExternalUserIds = new Set([externalUserId]);
const testMediaAssetIds = new Set<string>();
let testMediaPath: string | undefined;
const codexFixture = JSON.parse(readFileSync(
  new URL("./fixtures/codex-2026-conformance.json", import.meta.url),
  "utf8",
)) as {
  protocolVersion: string;
  discovery: { resultType: string; supportedVersions: string[] };
  completeResultType: string;
  mrtr: {
    pendingResultType: string;
    inputRequestKey: string;
    inputRequestMethod: string;
    acceptedChoice: string;
  };
};

function runTestBinary(command: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code === 0) resolveRun(Buffer.concat(stdout));
      else rejectRun(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString("utf8").slice(0, 1000)}`));
    });
    child.stdin.end(input);
  });
}

async function generateTestVideo(outputPath: string): Promise<void> {
  await runTestBinary("ffmpeg", [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", "testsrc2=duration=30:size=160x90:rate=10",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "25",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-y",
    outputPath,
  ]);
}

async function probeVideoDuration(video: Buffer): Promise<number> {
  const output = await runTestBinary("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    "pipe:0",
  ], video);
  return Number(output.toString("utf8").trim());
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

class WireClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly messages: JsonRpcResponse[] = [];
  readonly waiters: Array<(message: JsonRpcResponse) => void> = [];
  readonly stderr: string[] = [];

  constructor(options: {
    externalUserId?: string;
    actor?: string;
    runtimeVersion?: string;
    mediaRuntime?: "embedded" | "external" | "off";
    allowUserProvisioning?: boolean;
    testNow?: string;
    sensitivePayloadKey?: string;
  } = {}) {
    const binding = options.externalUserId ?? externalUserId;
    testExternalUserIds.add(binding);
    const tsxCli = resolve("node_modules", "tsx", "dist", "cli.mjs");
    this.child = spawn(process.execPath, [tsxCli, "src/mcp/stdio.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL,
        COMPASS_HEALTH_USER_BINDING: binding,
        COMPASS_HEALTH_ACTOR: options.actor ?? "codex-primary",
        ...(options.runtimeVersion
          ? { COMPASS_HEALTH_RUNTIME_VERSION: options.runtimeVersion } : {}),
        COMPASS_HEALTH_ALLOW_USER_PROVISIONING:
          options.allowUserProvisioning === false ? "false" : "true",
        COMPASS_HEALTH_MEDIA_RUNTIME: options.mediaRuntime ?? "off",
        ...(options.testNow ? { COMPASS_HEALTH_TEST_NOW: options.testNow } : {}),
        ...(options.sensitivePayloadKey
          ? {
              COMPASS_HEALTH_SENSITIVE_PAYLOAD_KEY: options.sensitivePayloadKey,
              COMPASS_HEALTH_SENSITIVE_PAYLOAD_KEY_VERSION: "wire-test-v1",
            }
          : {}),
        NODE_ENV: "test",
      },
      stdio: "pipe",
      windowsHide: true,
    });

    createInterface({ input: this.child.stdout }).on("line", (line) => {
      if (line.trim() === "") return;
      const message = JSON.parse(line) as JsonRpcResponse;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.messages.push(message);
    });
    createInterface({ input: this.child.stderr }).on("line", (line) => {
      this.stderr.push(line);
    });
  }

  async request(message: Record<string, unknown>): Promise<JsonRpcResponse> {
    const response = new Promise<JsonRpcResponse>((resolveResponse) => {
      const queued = this.messages.shift();
      if (queued) resolveResponse(queued);
      else this.waiters.push(resolveResponse);
    });
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return Promise.race([
      response,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error(`wire response timed out; stderr=${this.stderr.join(" | ")}`)),
        15_000,
      )),
    ]);
  }

  close(): void {
    this.child.stdin.end();
    if (!this.child.killed) this.child.kill();
  }
}

function modernMeta(): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: "compass-wire-test", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
  };
}

function toolCall(
  id: number,
  name: string,
  args: Record<string, unknown>,
  retry?: { requestState: string; inputResponses: Record<string, unknown> },
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      _meta: modernMeta(),
      name,
      arguments: args,
      ...(retry ?? {}),
    },
  };
}

function resourceRead(id: number, uri: string, runHandle: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "resources/read",
    params: {
      uri,
      _meta: { ...modernMeta(), "compass.health/runHandle": runHandle },
    },
  };
}

function bodyProfileArgs(
  runHandle: string,
  idempotencyKey: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runHandle,
    effectiveDate: "2026-08-27",
    sex: "female",
    ageYears: 34,
    heightCm: 166,
    weightKg: 72,
    goalWeightKg: 64,
    activityLevel: "strength_training",
    goal: "fat_loss_moderate",
    trainingCadence: "four_days_per_week",
    trainingSplit: "upper_lower",
    idempotencyKey,
    ...overrides,
  };
}

const clients: WireClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

afterAll(async () => {
  const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
  try {
    for (const id of testExternalUserIds) {
      const [user] = await sql`SELECT id FROM compass_health.users WHERE external_id = ${id}`;
      if (user) {
        await sql`DELETE FROM compass_health.outbox_events WHERE user_id = ${user.id}::uuid`;
        await sql`DELETE FROM compass_health.interaction_events WHERE user_id = ${user.id}::uuid`;
        await sql`
          DELETE FROM compass_health.projection_checkpoints
          WHERE projection_name = 'daily-health-state'
            AND checkpoint_key LIKE ${`${String(user.id)}:%`}`;
      }
      await sql`DELETE FROM compass_health.users WHERE external_id = ${id}`;
    }
    for (const assetId of testMediaAssetIds) {
      await sql`DELETE FROM compass_health.media_assets WHERE id = ${assetId}::uuid`;
    }
    if (testMediaPath !== undefined) {
      await unlink(testMediaPath).catch(() => undefined);
    }
  } finally {
    await sql.end({ timeout: 3 });
  }
});

describe("MCP 2026-07-28 stdio wire", () => {
  it("uses server/discover as the first request without initialize", async () => {
    const client = new WireClient();
    clients.push(client);

    const response = await client.request({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: modernMeta() },
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      resultType: "complete",
      supportedVersions: [PROTOCOL_VERSION],
      ttlMs: expect.any(Number),
      cacheScope: "public",
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "compass-health",
          version: expect.any(String),
        },
      },
    });
  }, 20_000);

  it("lists tools without an initialize handshake and returns a complete result", async () => {
    const client = new WireClient();
    clients.push(client);

    const response = await client.request({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: modernMeta() },
    });

    expect(response.error).toBeUndefined();
    expect(response.result?.resultType).toBe("complete");
    const tools = response.result?.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toContain("health_begin_run");
  }, 20_000);

  it("updates an effective-dated body profile and reads it back over the MCP wire", async () => {
    const binding = `mcp-wire-profile-${process.pid}-${Date.now()}`;
    const client = new WireClient({
      externalUserId: binding,
      testNow: "2026-08-27T08:00:00+08:00",
    });
    clients.push(client);

    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "update body profile",
      inputChannel: "mcp",
      idempotencyKey: "wire-profile-run",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;

    const args = bodyProfileArgs(runHandle, "wire-profile-update");
    const updated = await client.request(toolCall(2, "health_update_body_profile", args));

    expect(updated.error).toBeUndefined();
    expect(updated.result).toMatchObject({
      resultType: "complete",
      structuredContent: {
        profile: {
          effectiveDate: "2026-08-27",
          weightKg: 72,
          goalWeightKg: 64,
          trainingCadence: "four_days_per_week",
          trainingSplit: "upper_lower",
          targetKcal: expect.any(Number),
          proteinTargetGrams: expect.any(Number),
        },
        receiptId: expect.any(String),
        replayed: false,
      },
    });

    const profile = await client.request(resourceRead(3, "health://profile", runHandle));
    const contents = profile.result?.contents as Array<{ text: string }>;
    expect(JSON.parse(contents[0]!.text)).toMatchObject({
      bodyProfile: {
        effectiveDate: "2026-08-27",
        weightKg: 72,
        goalWeightKg: 64,
        trainingCadence: "four_days_per_week",
        trainingSplit: "upper_lower",
      },
    });

    const first = updated.result?.structuredContent as {
      profile: { id: string };
      receiptId: string;
    };
    const replay = await client.request(toolCall(4, "health_update_body_profile", args));
    expect(replay.result?.structuredContent).toMatchObject({
      profile: { id: first.profile.id },
      receiptId: first.receiptId,
      replayed: true,
    });
  }, 20_000);

  it("rejects a body-profile idempotency key reused from a different run", async () => {
    const binding = `mcp-wire-profile-run-binding-${process.pid}-${Date.now()}`;
    const client = new WireClient({ externalUserId: binding });
    clients.push(client);

    const firstRun = await client.request(toolCall(1, "health_begin_run", {
      objective: "first profile run",
      inputChannel: "mcp",
      idempotencyKey: "wire-profile-first-run",
    }));
    const firstRunHandle = (firstRun.result?.structuredContent as { runHandle: string }).runHandle;
    const first = await client.request(toolCall(
      2,
      "health_update_body_profile",
      bodyProfileArgs(firstRunHandle, "wire-profile-shared-key"),
    ));
    expect(first.result?.isError).not.toBe(true);

    const secondRun = await client.request(toolCall(3, "health_begin_run", {
      objective: "second profile run",
      inputChannel: "mcp",
      idempotencyKey: "wire-profile-second-run",
    }));
    const secondRunHandle = (secondRun.result?.structuredContent as { runHandle: string }).runHandle;
    const refused = await client.request(toolCall(
      4,
      "health_update_body_profile",
      bodyProfileArgs(secondRunHandle, "wire-profile-shared-key"),
    ));

    expect(refused.result).toMatchObject({
      resultType: "complete",
      isError: true,
      structuredContent: { error: "idempotency_conflict" },
    });
  }, 25_000);

  it("isolates the same body-profile idempotency key between users", async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const firstClient = new WireClient({ externalUserId: `mcp-wire-profile-user-a-${suffix}` });
    const secondClient = new WireClient({ externalUserId: `mcp-wire-profile-user-b-${suffix}` });
    clients.push(firstClient, secondClient);

    const firstRun = await firstClient.request(toolCall(1, "health_begin_run", {
      objective: "profile for user A",
      inputChannel: "mcp",
      idempotencyKey: "wire-profile-user-run",
    }));
    const secondRun = await secondClient.request(toolCall(1, "health_begin_run", {
      objective: "profile for user B",
      inputChannel: "mcp",
      idempotencyKey: "wire-profile-user-run",
    }));
    const firstRunHandle = (firstRun.result?.structuredContent as { runHandle: string }).runHandle;
    const secondRunHandle = (secondRun.result?.structuredContent as { runHandle: string }).runHandle;

    const first = await firstClient.request(toolCall(
      2,
      "health_update_body_profile",
      bodyProfileArgs(firstRunHandle, "wire-profile-user-shared-key"),
    ));
    const second = await secondClient.request(toolCall(
      2,
      "health_update_body_profile",
      bodyProfileArgs(secondRunHandle, "wire-profile-user-shared-key", {
        weightKg: 84,
        goalWeightKg: 76,
      }),
    ));
    const firstBody = first.result?.structuredContent as { profile: { id: string }; replayed: boolean };
    const secondBody = second.result?.structuredContent as { profile: { id: string }; replayed: boolean };

    expect(firstBody.replayed).toBe(false);
    expect(secondBody.replayed).toBe(false);
    expect(firstBody.profile.id).not.toBe(secondBody.profile.id);
  }, 25_000);

  it("rejects a non-real body-profile effective date without creating a fact", async () => {
    const binding = `mcp-wire-profile-invalid-date-${process.pid}-${Date.now()}`;
    const client = new WireClient({
      externalUserId: binding,
      testNow: "2026-08-27T08:00:00+08:00",
    });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "invalid profile date",
      inputChannel: "mcp",
      idempotencyKey: "wire-profile-invalid-date-run",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;

    const refused = await client.request(toolCall(
      2,
      "health_update_body_profile",
      bodyProfileArgs(runHandle, "wire-profile-invalid-date", { effectiveDate: "2026-02-30" }),
    ));
    expect(refused.result).toMatchObject({
      resultType: "complete",
      isError: true,
      structuredContent: { error: "validation_failed" },
    });

    const profile = await client.request(resourceRead(3, "health://profile", runHandle));
    const contents = profile.result?.contents as Array<{ text: string }>;
    expect(JSON.parse(contents[0]!.text)).toMatchObject({ bodyProfile: null });
  }, 20_000);

  it("advertises dynamic resources through resources/templates/list on the raw 2026 wire", async () => {
    const client = new WireClient();
    clients.push(client);

    const resources = await client.request({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/list",
      params: { _meta: modernMeta() },
    });
    expect(resources.error).toBeUndefined();
    expect(resources.result?.resultType).toBe("complete");
    const staticUris = (resources.result?.resources as Array<{ uri: string }>).map((entry) => entry.uri);
    expect(staticUris).toContain("health://daily-state/today");
    expect(staticUris.every((uri) => !uri.includes("{"))).toBe(true);

    const templates = await client.request({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/templates/list",
      params: { _meta: modernMeta() },
    });
    expect(templates.error).toBeUndefined();
    expect(templates.result).toMatchObject({
      resultType: "complete",
      ttlMs: expect.any(Number),
      cacheScope: "public",
    });
    const templateUris = (
      templates.result?.resourceTemplates as Array<{ uriTemplate: string }>
    ).map((entry) => entry.uriTemplate);
    expect(templateUris).toEqual([
      "health://constraints/active/{date}",
      "health://daily-state/{date}",
      "health://diet/logs/{date}",
      "health://training/sessions/{sessionId}",
    ]);
  }, 20_000);

  it("rejects an unknown production user binding without provisioning a blank user", async () => {
    const binding = `mcp-wire-unknown-binding-${process.pid}-${Date.now()}`;
    const tsxCli = resolve("node_modules", "tsx", "dist", "cli.mjs");
    const child = spawn(process.execPath, [tsxCli, "src/mcp/stdio.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL,
        COMPASS_HEALTH_USER_BINDING: binding,
        COMPASS_HEALTH_ALLOW_USER_PROVISIONING: "false",
        COMPASS_HEALTH_MEDIA_RUNTIME: "off",
        NODE_ENV: "production",
      },
      stdio: "pipe",
      windowsHide: true,
    });
    const stderr: string[] = [];
    createInterface({ input: child.stderr }).on("line", (line) => stderr.push(line));
    const exitCode = await Promise.race([
      once(child, "exit").then(([code]) => code as number | null),
      new Promise<null>((resolveTimeout) => setTimeout(() => resolveTimeout(null), 4_000)),
    ]);
    if (exitCode === null && !child.killed) {
      child.kill();
      await once(child, "exit");
    }
    expect(exitCode, stderr.join(" | ")).toBe(1);
    expect(stderr.join(" | ")).toContain("unknown user binding");

    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const rows = await sql`
        SELECT id FROM compass_health.users WHERE external_id = ${binding}`;
      expect(rows).toHaveLength(0);
    } finally {
      await sql.end({ timeout: 3 });
    }
  }, 12_000);

  it("refuses to start without an explicit database binding", async () => {
    const tsxCli = resolve("node_modules", "tsx", "dist", "cli.mjs");
    const child = spawn(process.execPath, [tsxCli, "src/mcp/stdio.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: "",
        COMPASS_HEALTH_USER_BINDING: "must-not-use-default-database",
        COMPASS_HEALTH_MEDIA_RUNTIME: "off",
        NODE_ENV: "production",
      },
      stdio: "pipe",
      windowsHide: true,
    });
    const stderr: string[] = [];
    createInterface({ input: child.stderr }).on("line", (line) => stderr.push(line));
    const [exitCode] = await once(child, "exit") as [number | null];

    expect(exitCode, stderr.join(" | ")).toBe(2);
    expect(stderr.join(" | ")).toContain("DATABASE_URL is required");
  }, 12_000);

  it("uses the bound user's timezone for tool and resource default dates", async () => {
    const binding = `mcp-wire-local-date-${process.pid}-${Date.now()}`;
    testExternalUserIds.add(binding);
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      await sql`
        INSERT INTO compass_health.users (external_id, locale, timezone)
        VALUES (${binding}, 'en', 'America/Los_Angeles')`;
    } finally {
      await sql.end({ timeout: 3 });
    }

    const client = new WireClient({
      externalUserId: binding,
      allowUserProvisioning: false,
      testNow: "2035-04-01T00:30:00.000Z",
    });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire local date boundary",
      idempotencyKey: "wire-local-date-run",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const recorded = await client.request(toolCall(2, "health_record_water", {
      runHandle,
      amountMl: 275,
      idempotencyKey: "wire-local-date-water",
    }));
    expect(recorded.result?.resultType).toBe("complete");

    const resource = await client.request(resourceRead(
      3,
      "health://daily-state/today",
      runHandle,
    ));
    const body = JSON.parse(
      (resource.result?.contents as Array<{ text: string }>)[0]!.text,
    ) as { schemaVersion: string; localDate: string };
    expect(body.schemaVersion).toBe("daily-health-state.v2");
    expect(body.localDate).toBe("2035-03-31");

    const verify = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const [row] = await verify`
        SELECT water.log_date::text AS log_date, outbox.payload_json
        FROM compass_health.water_logs water
        JOIN compass_health.users usr ON usr.id = water.user_id
        JOIN compass_health.outbox_events outbox ON outbox.aggregate_id = water.id::text
        WHERE usr.external_id = ${binding}
          AND water.amount_ml = 275`;
      expect(row?.log_date).toBe("2035-03-31");
      expect(row?.payload_json).toMatchObject({ observedOn: "2035-03-31" });
    } finally {
      await verify.end({ timeout: 3 });
    }
  }, 25_000);

  it("covers every J01-J09 journey with discoverable tools", async () => {
    const client = new WireClient();
    clients.push(client);
    const response = await client.request({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: modernMeta() },
    });
    const discoveredTools = response.result?.tools as Array<{
      name: string;
      inputSchema: { required?: string[]; properties?: Record<string, unknown> };
      _meta?: { "compass.health/risk"?: string };
    }>;
    const names = new Set(discoveredTools.map((tool) => tool.name));
    const coverage: Record<string, string[]> = {
      J01: [
        "health_update_body_profile",
        "health_generate_diet_plan",
        "health_get_diet_plan",
        "health_log_meal",
      ],
      J02: ["health_prepare_training", "health_start_training", "health_record_set", "health_finish_training"],
      J03: ["health_record_sleep", "health_record_fatigue", "health_acknowledge_rest"],
      J04: ["health_report_pain", "health_lift_constraint"],
      J05: ["health_propose_substitution", "health_apply_substitution"],
      J06: ["health_search_training_media", "health_record_media_feedback"],
      J07: ["health_record_reflection", "health_propose_plan_change", "health_activate_plan_version"],
      J08: ["health_log_meal", "health_correct_meal"],
      J09: ["health_get_projection_diagnostics", "health_replay_projection"],
    };
    for (const [journey, required] of Object.entries(coverage)) {
      expect(required.filter((name) => !names.has(name)), `${journey} missing tools`).toEqual([]);
    }
    const mealTool = discoveredTools.find((tool) => tool.name === "health_log_meal")!;
    expect(mealTool.inputSchema.required).toEqual(expect.arrayContaining(["items", "resolutionMode"]));
    expect(names).toContain("health_get_run_evidence");
    for (const name of [
      "health_get_daily_state",
      "health_get_active_constraints",
      "health_get_training_cycle",
      "health_get_active_plan",
      "health_search_training_media",
      "health_get_projection_diagnostics",
    ]) {
      const readTool = discoveredTools.find((tool) => tool.name === name)!;
      expect(readTool.inputSchema.required, `${name} formal run`).toContain("runHandle");
    }
    expect(names).not.toContain("test_missing_capability");
    for (const tool of discoveredTools) {
      if (tool._meta?.["compass.health/risk"] === "read-only") continue;
      expect(tool.inputSchema.required, `${tool.name} idempotency`).toContain("idempotencyKey");
      if (tool.name !== "health_begin_run") {
        expect(tool.inputSchema.required, `${tool.name} runHandle`).toContain("runHandle");
      }
    }
    const waterTool = discoveredTools.find((tool) => tool.name === "health_record_water")!;
    expect(waterTool.inputSchema.properties?.date).toEqual({
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
    });
  }, 20_000);

  it("passes the pinned Codex MCP 2026 discovery and MRTR fixture", async () => {
    expect(codexFixture.protocolVersion).toBe(PROTOCOL_VERSION);
    const client = new WireClient();
    clients.push(client);
    const discover = await client.request({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: modernMeta() },
    });
    expect(discover.result).toMatchObject(codexFixture.discovery);

    const begun = await client.request(toolCall(2, "health_begin_run", {
      objective: "pinned Codex conformance fixture",
      idempotencyKey: "codex-fixture-run",
    }));
    expect(begun.result?.resultType).toBe(codexFixture.completeResultType);
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const pain = await client.request(toolCall(3, "health_report_pain", {
      runHandle,
      bodyPart: "膝盖",
      severity: "sharp",
      idempotencyKey: "codex-fixture-pain",
    }));
    const constraintId = (pain.result?.structuredContent as { constraintId: string }).constraintId;
    const args = {
      runHandle,
      constraintId,
      idempotencyKey: "codex-fixture-lift",
    };
    const pending = await client.request(toolCall(4, "health_lift_constraint", args));
    expect(pending.result?.resultType).toBe(codexFixture.mrtr.pendingResultType);
    const inputRequests = pending.result?.inputRequests as Record<string, { method: string }>;
    expect(inputRequests[codexFixture.mrtr.inputRequestKey]?.method)
      .toBe(codexFixture.mrtr.inputRequestMethod);

    const completed = await client.request(toolCall(5, "health_lift_constraint", args, {
      requestState: pending.result?.requestState as string,
      inputResponses: {
        [codexFixture.mrtr.inputRequestKey]: {
          action: "accept",
          content: { choice: codexFixture.mrtr.acceptedChoice },
        },
      },
    }));
    expect(completed.result?.resultType).toBe(codexFixture.completeResultType);
    expect(completed.result?.structuredContent).toMatchObject({ lifted: true, constraintId });
  }, 30_000);

  it("ignores an unverified actor label from request metadata", async () => {
    const binding = `mcp-wire-actor-${process.pid}-${Date.now()}`;
    const client = new WireClient({ externalUserId: binding, actor: "verified-codex" });
    clients.push(client);
    const request = toolCall(1, "health_begin_run", {
      objective: "verified actor binding",
      idempotencyKey: "wire-verified-actor",
    });
    const params = request.params as { _meta: Record<string, unknown> };
    params._meta["compass.health/actor"] = "spoofed-reviewer";
    const response = await client.request(request);
    const body = response.result?.structuredContent as { actor: string; receiptId: string };
    expect(body.actor).toBe("verified-codex");

    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const [receipt] = await sql`
        SELECT verified_actor FROM compass_health.mcp_write_receipts
        WHERE id = ${body.receiptId}::uuid`;
      expect(receipt?.verified_actor).toBe("verified-codex");
    } finally {
      await sql.end({ timeout: 3 });
    }
  }, 20_000);

  it("binds a formal Actor Profile to the run and refuses cross-actor receipt replay", async () => {
    const binding = `mcp-wire-formal-actor-${process.pid}-${Date.now()}`;
    const actorA = new WireClient({
      externalUserId: binding,
      actor: "codex-primary",
      runtimeVersion: "runtime-build-a",
    });
    clients.push(actorA);
    const begun = await actorA.request(toolCall(1, "health_begin_run", {
      objective: "formal actor receipt boundary",
      idempotencyKey: "wire-formal-actor-run",
    }));
    const run = begun.result?.structuredContent as {
      runHandle: string;
      receiptId: string;
    };
    const waterArgs = {
      runHandle: run.runHandle,
      amountMl: 275,
      idempotencyKey: "wire-formal-actor-water",
    };
    const written = await actorA.request(toolCall(2, "health_record_water", waterArgs));
    const originalReceiptId = (written.result?.structuredContent as { receiptId: string }).receiptId;

    const actorB = new WireClient({
      externalUserId: binding,
      actor: "codex-primary",
      runtimeVersion: "runtime-build-b",
    });
    clients.push(actorB);
    const refused = await actorB.request(toolCall(1, "health_record_water", waterArgs));
    expect(refused.result?.structuredContent).toMatchObject({ error: "actor_mismatch" });

    const bootstrapReplay = await actorB.request(toolCall(2, "health_begin_run", {
      objective: "formal actor receipt boundary",
      idempotencyKey: "wire-formal-actor-run",
    }));
    expect(bootstrapReplay.result?.structuredContent).toMatchObject({ error: "actor_mismatch" });

    const evidence = await actorA.request(toolCall(3, "health_get_run_evidence", {
      runHandle: run.runHandle,
    }));
    expect(evidence.result?.structuredContent).toMatchObject({
      actor: {
        actorType: "codex",
        runtimeName: "codex",
        agentProfile: "codex-primary",
        runtimeVersion: "runtime-build-a",
        status: "active",
      },
    });

    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const [formal] = await sql`
        SELECT run.actor_id, actor.actor_type, actor.runtime_name,
               actor.runtime_version, actor.agent_profile
        FROM compass_health.agent_runs run
        JOIN compass_health.agent_actors actor ON actor.id = run.actor_id
        WHERE run.id = ${run.runHandle}::uuid`;
      expect(formal).toMatchObject({
        actor_type: "codex",
        runtime_name: "codex",
        runtime_version: "runtime-build-a",
        agent_profile: "codex-primary",
      });
      const receipts = await sql`
        SELECT id FROM compass_health.mcp_write_receipts
        WHERE id = ${originalReceiptId}::uuid`;
      expect(receipts).toHaveLength(1);
    } finally {
      await sql.end({ timeout: 3 });
    }
  }, 30_000);

  it("stores userAccepted as a user decision while run lifecycle stays operational", async () => {
    const binding = `mcp-wire-run-decision-${process.pid}-${Date.now()}`;
    const client = new WireClient({ externalUserId: binding });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "run outcome decision evidence",
      idempotencyKey: "wire-run-decision-begin",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const ended = await client.request(toolCall(2, "health_end_run", {
      runHandle,
      outcome: "completed",
      userAccepted: false,
      idempotencyKey: "wire-run-decision-end",
    }));
    expect(ended.result?.structuredContent).toMatchObject({
      runHandle,
      outcome: "completed",
      userAccepted: false,
    });

    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const [user] = await sql`SELECT id FROM compass_health.users WHERE external_id = ${binding}`;
      const decisions = await sql`
        SELECT decision_type, subject_json
        FROM compass_health.user_decision_events
        WHERE user_id = ${user!.id}::uuid
          AND subject_json->>'type' = 'agent_run_outcome'`;
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        decision_type: "rejected",
        subject_json: {
          type: "agent_run_outcome",
          runId: runHandle,
          accepted: false,
          outcome: "completed",
        },
      });
      const [counts] = await sql`
        SELECT
          (SELECT count(*)::int FROM compass_health.interaction_events
           WHERE user_id = ${user!.id}::uuid AND stage = 'agent_run') AS lifecycle_audits,
          (SELECT count(*)::int FROM compass_health.outbox_events
           WHERE user_id = ${user!.id}::uuid
             AND type IN ('agent.run_started', 'agent.run_ended')) AS lifecycle_outbox,
          (SELECT count(*)::int FROM compass_health.outbox_events
           WHERE user_id = ${user!.id}::uuid
             AND type = 'user.decision_recorded'
             AND payload_json ? 'observedOn') AS decision_outbox`;
      expect(counts).toMatchObject({
        lifecycle_audits: 2,
        lifecycle_outbox: 0,
        decision_outbox: 1,
      });
    } finally {
      await sql.end({ timeout: 3 });
    }
  }, 25_000);

  it("keeps objective and response summary plaintext out of wire-level run evidence", async () => {
    const binding = `mcp-wire-private-evidence-${process.pid}-${Date.now()}`;
    const client = new WireClient({
      externalUserId: binding,
      sensitivePayloadKey: "wire-test-sensitive-payload-key-with-at-least-32-characters",
    });
    clients.push(client);
    const objective = "private objective about sharp right shoulder pain";
    const responseSummary = "private response summary about unresolved shoulder pain";
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective,
      idempotencyKey: "wire-private-evidence-begin",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const ended = await client.request(toolCall(2, "health_end_run", {
      runHandle,
      outcome: "completed",
      responseSummary,
      idempotencyKey: "wire-private-evidence-end",
    }));
    expect(ended.result?.resultType).toBe("complete");
    const evidence = await client.request(toolCall(3, "health_get_run_evidence", { runHandle }));
    const evidenceJson = JSON.stringify(evidence.result?.structuredContent);
    expect(evidenceJson).not.toContain(objective);
    expect(evidenceJson).not.toContain(responseSummary);

    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const [run] = await sql`
        SELECT objective, response_summary, objective_payload_id, response_summary_payload_id
        FROM compass_health.agent_runs
        WHERE id = ${runHandle}::uuid`;
      expect(String(run?.objective)).not.toContain(objective);
      expect(String(run?.response_summary)).not.toContain(responseSummary);
      expect(run?.objective_payload_id).toEqual(expect.any(String));
      expect(run?.response_summary_payload_id).toEqual(expect.any(String));
      const payloads = await sql`
        SELECT payload_type, ciphertext, content_hash, content_length
        FROM compass_health.sensitive_payloads
        WHERE id IN (${run!.objective_payload_id}::uuid, ${run!.response_summary_payload_id}::uuid)
        ORDER BY payload_type`;
      expect(payloads).toHaveLength(2);
      expect(JSON.stringify(payloads)).not.toContain(objective);
      expect(JSON.stringify(payloads)).not.toContain(responseSummary);
      expect(payloads.every((payload) => /^[a-f0-9]{64}$/.test(String(payload.content_hash))))
        .toBe(true);
    } finally {
      await sql.end({ timeout: 3 });
    }
  }, 25_000);

  it("rejects confirming plan version A and activating plan version B", async () => {
    const client = new WireClient();
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire plan activation binding",
      idempotencyKey: "wire-run-plan-binding",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    let parentId = "";
    let planA = "";
    let planB = "";
    try {
      const [user] = await sql`
        SELECT id FROM compass_health.users WHERE external_id = ${externalUserId}`;
      const scope = `activation-security-${Date.now()}`;
      const [parent] = await sql`
        INSERT INTO compass_health.plan_versions
          (user_id, scope, status, content_json, version_number)
        VALUES (${user!.id}::uuid, ${scope}, 'active', '{}'::jsonb, 1)
        RETURNING id`;
      parentId = String(parent!.id);
      await sql`
        INSERT INTO compass_health.active_plan_assignments
          (user_id, scope, plan_version_id)
        VALUES (${user!.id}::uuid, ${scope}, ${parentId}::uuid)`;
      const governedContent = (label: string) => JSON.stringify({
        days: {},
        planDiff: {
          changes: [{ kind: "wire_fixture", target: {}, before: null, after: { label } }],
          changedDays: [],
        },
        governance: {
          schemaVersion: "plan-governance.v1",
          proposalArgumentHash: `wire-${label}`,
          reviewedBy: "deterministic_plan_governance.v1",
          reviewStatus: "approved",
          reviewReasons: ["wire fixture deterministic review passed"],
          rollbackTargetVersionId: parentId,
          validationQuestions: [`validate ${label}`],
          highFrequencyCycle: false,
          recoveryEvidence: null,
        },
      });
      const drafts = await sql`
        INSERT INTO compass_health.plan_versions
          (user_id, scope, status, parent_version_id, content_json, validation_questions, version_number)
        VALUES
          (${user!.id}::uuid, ${scope}, 'draft', ${parentId}::uuid,
           ${governedContent("plan-a")}::jsonb, '["validate plan-a"]'::jsonb, 2),
          (${user!.id}::uuid, ${scope}, 'draft', ${parentId}::uuid,
           ${governedContent("plan-b")}::jsonb, '["validate plan-b"]'::jsonb, 3)
        RETURNING id, version_number`;
      drafts.sort((left, right) => Number(left.version_number) - Number(right.version_number));
      planA = String(drafts[0]!.id);
      planB = String(drafts[1]!.id);
    } finally {
      await sql.end({ timeout: 3 });
    }

    const pending = await client.request(toolCall(2, "health_activate_plan_version", {
      runHandle,
      planVersionId: planA,
      idempotencyKey: "wire-plan-binding",
    }));
    expect(pending.result?.resultType).toBe("input_required");
    const rejected = await client.request(toolCall(3, "health_activate_plan_version", {
      runHandle,
      planVersionId: planB,
      idempotencyKey: "wire-plan-binding",
    }, {
      requestState: pending.result?.requestState as string,
      inputResponses: {
        confirmation: { action: "accept", content: { choice: "确认激活" } },
      },
    }));
    expect(rejected.result?.structuredContent).toMatchObject({ error: "proposal_stale" });

    const verify = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const rows = await verify`
        SELECT id, status FROM compass_health.plan_versions
        WHERE id IN (${parentId}::uuid, ${planA}::uuid, ${planB}::uuid)`;
      const statuses = new Map(rows.map((row) => [String(row.id), String(row.status)]));
      expect(statuses.get(parentId)).toBe("active");
      expect(statuses.get(planA)).toBe("draft");
      expect(statuses.get(planB)).toBe("draft");
    } finally {
      await verify.end({ timeout: 3 });
    }
  }, 30_000);

  it("rejects a modern request that omits protocol metadata", async () => {
    const client = new WireClient();
    clients.push(client);

    const discover = await client.request({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: modernMeta() },
    });
    expect(discover.error).toBeUndefined();

    const response = await client.request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    expect(response.error?.code).toBe(-32022);
  }, 20_000);

  it("completes a standard MRTR confirmation round trip", async () => {
    const client = new WireClient();
    clients.push(client);

    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire MRTR confirmation",
      idempotencyKey: "wire-run-standard",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;

    const pain = await client.request(toolCall(2, "health_report_pain", {
      runHandle,
      bodyPart: "膝盖",
      severity: "sharp",
      idempotencyKey: "wire-pain-standard",
    }));
    const constraintId = (pain.result?.structuredContent as { constraintId: string }).constraintId;

    const first = await client.request(toolCall(3, "health_lift_constraint", {
      runHandle,
      constraintId,
      idempotencyKey: "wire-lift-standard",
    }));
    expect(first.result?.resultType).toBe("input_required");
    const requestState = first.result?.requestState as string;
    expect(requestState).toEqual(expect.any(String));
    expect(first.result?.inputRequests).toHaveProperty("confirmation");

    const completed = await client.request(toolCall(4, "health_lift_constraint", {
      runHandle,
      constraintId,
      idempotencyKey: "wire-lift-standard",
    }, {
      requestState,
      inputResponses: {
        confirmation: { action: "accept", content: { choice: "确认解除" } },
      },
    }));

    expect(completed.result?.resultType).toBe("complete");
    const completedBody = completed.result?.structuredContent as {
      constraintId: string; lifted: boolean; receiptId: string; replayed: boolean;
    };
    expect(completedBody).toMatchObject({ constraintId, lifted: true, replayed: false });

    const replayed = await client.request(toolCall(5, "health_lift_constraint", {
      runHandle,
      constraintId,
      idempotencyKey: "wire-lift-standard",
    }, {
      requestState,
      inputResponses: {
        confirmation: { action: "accept", content: { choice: "确认解除" } },
      },
    }));
    expect(replayed.result?.structuredContent).toMatchObject({
      constraintId,
      lifted: true,
      receiptId: completedBody.receiptId,
      replayed: true,
    });

    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const [counts] = await sql`
        SELECT
          (SELECT count(*)::int FROM compass_health.user_decision_events
           WHERE subject_json->>'type' = 'constraint_lift'
             AND subject_json->>'constraintId' = ${constraintId}) AS decisions,
          (SELECT count(*)::int FROM compass_health.outbox_events
           WHERE aggregate_id = ${constraintId} AND type = 'constraint.lifted') AS outbox,
          (SELECT count(*)::int FROM compass_health.mcp_write_receipts
           WHERE id = ${completedBody.receiptId}::uuid) AS receipts`;
      expect(counts).toMatchObject({ decisions: 1, outbox: 1, receipts: 1 });
    } finally {
      await sql.end({ timeout: 3 });
    }
  }, 25_000);

  it("replays a successful plan activation from the original receipt", async () => {
    const binding = `mcp-wire-activate-replay-${process.pid}-${Date.now()}`;
    const client = new WireClient({
      externalUserId: binding,
      testNow: "2026-08-26T04:00:00.000Z",
    });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire activation success replay",
      idempotencyKey: "wire-activation-replay-run",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    let childId = "";
    try {
      const [user] = await sql`SELECT id FROM compass_health.users WHERE external_id = ${binding}`;
      const scope = "training_template";
      const [parent] = await sql`
        INSERT INTO compass_health.plan_versions
          (user_id, scope, status, content_json, version_number)
        VALUES (${user!.id}::uuid, ${scope}, 'active', '{"days":{}}'::jsonb, 1)
        RETURNING id`;
      const governedChildContent = JSON.stringify({
        days: {},
        planDiff: {
          changes: [{ kind: "wire_fixture", target: {}, before: null, after: { replay: true } }],
          changedDays: [],
        },
        governance: {
          schemaVersion: "plan-governance.v1",
          proposalArgumentHash: "wire-activation-replay",
          reviewedBy: "deterministic_plan_governance.v1",
          reviewStatus: "approved",
          reviewReasons: ["wire fixture deterministic review passed"],
          rollbackTargetVersionId: String(parent!.id),
          validationQuestions: ["validate activation receipt replay"],
          highFrequencyCycle: false,
          recoveryEvidence: null,
        },
      });
      const [child] = await sql`
        INSERT INTO compass_health.plan_versions
          (user_id, scope, status, parent_version_id, content_json, validation_questions, version_number)
        VALUES (${user!.id}::uuid, ${scope}, 'draft', ${parent!.id}::uuid,
          ${governedChildContent}::jsonb, '["validate activation receipt replay"]'::jsonb, 2)
        RETURNING id`;
      await sql`
        INSERT INTO compass_health.active_plan_assignments (user_id, scope, plan_version_id)
        VALUES (${user!.id}::uuid, ${scope}, ${parent!.id}::uuid)`;
      await sql`
        INSERT INTO compass_health.daily_health_state_projection
          (user_id, state_date, timezone, state_json, projection_status)
        VALUES
          (${user!.id}::uuid, '2026-08-26', 'Asia/Shanghai', '{}'::jsonb, 'fresh'),
          (${user!.id}::uuid, '2026-08-27', 'Asia/Shanghai', '{}'::jsonb, 'fresh'),
          (${user!.id}::uuid, '2026-09-01', 'Asia/Shanghai', '{}'::jsonb, 'fresh')`;
      childId = String(child!.id);
    } finally {
      await sql.end({ timeout: 3 });
    }

    const args = {
      runHandle,
      planVersionId: childId,
      idempotencyKey: "wire-activation-replay",
    };
    const pending = await client.request(toolCall(2, "health_activate_plan_version", args));
    expect(pending.result?.resultType).toBe("input_required");
    const retry = {
      requestState: pending.result?.requestState as string,
      inputResponses: {
        confirmation: { action: "accept", content: { choice: "确认激活" } },
      },
    };
    const completed = await client.request(toolCall(3, "health_activate_plan_version", args, retry));
    const body = completed.result?.structuredContent as { receiptId: string };
    expect(completed.result?.structuredContent).toMatchObject({
      planVersionId: childId, activated: true, replayed: false,
    });

    const replayed = await client.request(toolCall(4, "health_activate_plan_version", args, retry));
    expect(replayed.result?.structuredContent).toMatchObject({
      planVersionId: childId,
      activated: true,
      receiptId: body.receiptId,
      replayed: true,
    });

    const verify = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const [counts] = await verify`
        SELECT
          (SELECT count(*)::int FROM compass_health.user_decision_events
           WHERE subject_json->>'type' = 'plan_activation'
             AND subject_json->>'planVersionId' = ${childId}) AS decisions,
          (SELECT count(*)::int FROM compass_health.outbox_events
           WHERE aggregate_id = ${childId} AND type = 'plan.version_activated') AS outbox`;
      expect(counts).toMatchObject({ decisions: 1, outbox: 3 });
      const affected = await verify<Array<{ observed_on: string; projection_status: string }>>`
        SELECT event.payload_json ->> 'observedOn' AS observed_on, projection.projection_status
        FROM compass_health.outbox_events event
        JOIN compass_health.daily_health_state_projection projection
          ON projection.user_id = event.user_id
         AND projection.state_date::text = event.payload_json ->> 'observedOn'
        WHERE event.aggregate_id = ${childId}
          AND event.type = 'plan.version_activated'
        ORDER BY event.payload_json ->> 'observedOn'`;
      expect(affected).toEqual([
        { observed_on: "2026-08-26", projection_status: "lagging" },
        { observed_on: "2026-08-27", projection_status: "lagging" },
        { observed_on: "2026-09-01", projection_status: "lagging" },
      ]);
    } finally {
      await verify.end({ timeout: 3 });
    }
  }, 30_000);

  it("recovers requestState after the server process restarts", async () => {
    const firstProcess = new WireClient();
    clients.push(firstProcess);

    const begun = await firstProcess.request(toolCall(1, "health_begin_run", {
      objective: "wire MRTR restart",
      idempotencyKey: "wire-run-restart",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const pain = await firstProcess.request(toolCall(2, "health_report_pain", {
      runHandle,
      bodyPart: "肩",
      severity: "sharp",
      idempotencyKey: "wire-pain-restart",
    }));
    const constraintId = (pain.result?.structuredContent as { constraintId: string }).constraintId;
    const pending = await firstProcess.request(toolCall(3, "health_lift_constraint", {
      runHandle,
      constraintId,
      idempotencyKey: "wire-lift-restart",
    }));
    const requestState = pending.result?.requestState as string;
    expect(requestState).toEqual(expect.any(String));

    firstProcess.close();
    clients.splice(clients.indexOf(firstProcess), 1);

    const restarted = new WireClient();
    clients.push(restarted);
    const completed = await restarted.request(toolCall(4, "health_lift_constraint", {
      runHandle,
      constraintId,
      idempotencyKey: "wire-lift-restart",
    }, {
      requestState,
      inputResponses: {
        confirmation: { action: "accept", content: { choice: "确认解除" } },
      },
    }));

    expect(completed.result?.resultType).toBe("complete");
    expect(completed.result?.structuredContent).toMatchObject({ constraintId, lifted: true });
  }, 30_000);

  it("rejects confirming target A and executing target B", async () => {
    const client = new WireClient();
    clients.push(client);

    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire target binding",
      idempotencyKey: "wire-run-target-binding",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const firstPain = await client.request(toolCall(2, "health_report_pain", {
      runHandle, bodyPart: "膝盖", severity: "sharp", idempotencyKey: "wire-pain-target-a",
    }));
    const secondPain = await client.request(toolCall(3, "health_report_pain", {
      runHandle, bodyPart: "肩", severity: "sharp", idempotencyKey: "wire-pain-target-b",
    }));
    const constraintA = (firstPain.result?.structuredContent as { constraintId: string }).constraintId;
    const constraintB = (secondPain.result?.structuredContent as { constraintId: string }).constraintId;
    const pending = await client.request(toolCall(4, "health_lift_constraint", {
      runHandle, constraintId: constraintA, idempotencyKey: "wire-target-binding",
    }));
    const requestState = pending.result?.requestState as string;

    const rejected = await client.request(toolCall(5, "health_lift_constraint", {
      runHandle, constraintId: constraintB, idempotencyKey: "wire-target-binding",
    }, {
      requestState,
      inputResponses: {
        confirmation: { action: "accept", content: { choice: "确认解除" } },
      },
    }));

    expect(rejected.result?.structuredContent).toMatchObject({ error: "proposal_stale" });
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const rows = await sql`
        SELECT id, lifted_at FROM compass_health.health_constraints
        WHERE id IN (${constraintA}::uuid, ${constraintB}::uuid)
        ORDER BY id`;
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.lifted_at === null)).toBe(true);
    } finally {
      await sql.end({ timeout: 3 });
    }
  }, 30_000);

  it("rejects reusing requestState from a different runHandle", async () => {
    const client = new WireClient();
    clients.push(client);

    const firstRun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire run binding A",
      idempotencyKey: "wire-run-binding-a",
    }));
    const runA = (firstRun.result?.structuredContent as { runHandle: string }).runHandle;
    const pain = await client.request(toolCall(2, "health_report_pain", {
      runHandle: runA, bodyPart: "肘", severity: "sharp", idempotencyKey: "wire-pain-run-binding",
    }));
    const constraintId = (pain.result?.structuredContent as { constraintId: string }).constraintId;
    const pending = await client.request(toolCall(3, "health_lift_constraint", {
      runHandle: runA, constraintId, idempotencyKey: "wire-run-binding",
    }));
    const requestState = pending.result?.requestState as string;

    const secondRun = await client.request(toolCall(4, "health_begin_run", {
      objective: "wire run binding B",
      idempotencyKey: "wire-run-binding-b",
    }));
    const runB = (secondRun.result?.structuredContent as { runHandle: string }).runHandle;
    const rejected = await client.request(toolCall(5, "health_lift_constraint", {
      runHandle: runB, constraintId, idempotencyKey: "wire-run-binding",
    }, {
      requestState,
      inputResponses: {
        confirmation: { action: "accept", content: { choice: "确认解除" } },
      },
    }));

    expect(rejected.result?.structuredContent).toMatchObject({ error: "proposal_stale" });
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const [row] = await sql`
        SELECT lifted_at FROM compass_health.health_constraints WHERE id = ${constraintId}::uuid`;
      expect(row?.lifted_at).toBeNull();
    } finally {
      await sql.end({ timeout: 3 });
    }
  }, 30_000);

  it("rejects requestState when the original argument hash changes", async () => {
    const client = new WireClient();
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire argument hash binding",
      idempotencyKey: "wire-run-argument-hash",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const pain = await client.request(toolCall(2, "health_report_pain", {
      runHandle,
      bodyPart: "腰",
      severity: "sharp",
      idempotencyKey: "wire-pain-argument-hash",
    }));
    const constraintId = (pain.result?.structuredContent as { constraintId: string }).constraintId;
    const original = {
      runHandle,
      constraintId,
      idempotencyKey: "wire-lift-argument-hash",
    };
    const pending = await client.request(toolCall(3, "health_lift_constraint", original));
    const rejected = await client.request(toolCall(4, "health_lift_constraint", {
      ...original,
      tampered: true,
    }, {
      requestState: pending.result?.requestState as string,
      inputResponses: {
        confirmation: { action: "accept", content: { choice: "确认解除" } },
      },
    }));
    expect(rejected.result?.structuredContent).toMatchObject({ error: "proposal_stale" });
  }, 20_000);

  it("commits water fact, outbox, and receipt once and replays by idempotency key", async () => {
    const client = new WireClient();
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire water idempotency",
      idempotencyKey: "wire-run-water",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const args = {
      runHandle,
      amountMl: 321,
      date: "2026-08-25",
      idempotencyKey: "wire-water-once",
    };

    const first = await client.request(toolCall(2, "health_record_water", args));
    const replay = await client.request(toolCall(3, "health_record_water", args));
    const firstBody = first.result?.structuredContent as { waterLogId: string; receiptId: string; replayed: boolean };
    const replayBody = replay.result?.structuredContent as { waterLogId: string; receiptId: string; replayed: boolean };

    expect(firstBody.replayed).toBe(false);
    expect(replayBody).toMatchObject({
      waterLogId: firstBody.waterLogId,
      receiptId: firstBody.receiptId,
      replayed: true,
    });

    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const [counts] = await sql`
        SELECT
          (SELECT count(*)::int FROM compass_health.water_logs WHERE id = ${firstBody.waterLogId}::uuid) AS facts,
          (SELECT count(*)::int FROM compass_health.outbox_events WHERE aggregate_id = ${firstBody.waterLogId}) AS outbox,
          (SELECT count(*)::int FROM compass_health.mcp_write_receipts WHERE id = ${firstBody.receiptId}::uuid) AS receipts`;
      expect(counts).toMatchObject({ facts: 1, outbox: 1, receipts: 1 });
    } finally {
      await sql.end({ timeout: 3 });
    }
  }, 30_000);

  it("shows lagging and failed projection state through the Daily State Resource", async () => {
    const client = new WireClient();
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire projection diagnostics",
      idempotencyKey: "wire-run-projection",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const water = await client.request(toolCall(2, "health_record_water", {
      runHandle,
      amountMl: 222,
      date: "2026-08-24",
      idempotencyKey: "wire-water-projection",
    }));
    const waterLogId = (water.result?.structuredContent as { waterLogId: string }).waterLogId;

    const laggingRead = await client.request(resourceRead(
      3,
      "health://daily-state/2026-08-24",
      runHandle,
    ));
    const laggingContent = (laggingRead.result?.contents as Array<{ text: string }>)[0]!;
    const lagging = JSON.parse(laggingContent.text) as { projection: { status: string } };
    expect(lagging.projection.status).toBe("lagging");

    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      await sql`
        UPDATE compass_health.outbox_events
        SET status = 'dead_letter', last_error = 'wire-projection-failure'
        WHERE aggregate_id = ${waterLogId}`;
    } finally {
      await sql.end({ timeout: 3 });
    }

    const failedRead = await client.request(resourceRead(
      4,
      "health://daily-state/2026-08-24",
      runHandle,
    ));
    const failedContent = (failedRead.result?.contents as Array<{ text: string }>)[0]!;
    const failed = JSON.parse(failedContent.text) as {
      projection: { status: string; outbox: { failures: Array<{ lastError: string }> } };
    };
    expect(failed.projection.status).toBe("failed");
    expect(failed.projection.outbox.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ lastError: "wire-projection-failure" }),
    ]));
    const replayed = await client.request(toolCall(5, "health_replay_projection", {
      runHandle,
      date: "2026-08-24",
      idempotencyKey: "wire-replay-projection",
    }));
    expect(replayed.result?.structuredContent).toMatchObject({
      date: "2026-08-24",
      status: "fresh",
      drained: 1,
      diagnostics: {
        status: "fresh",
        outbox: { pending: 0, processing: 0, deadLetter: 0 },
      },
    });
    expect((replayed.result?.structuredContent as { revived: number }).revived).toBeGreaterThan(0);
    const diagnostics = await client.request(toolCall(6, "health_get_projection_diagnostics", {
      runHandle,
      date: "2026-08-24",
    }));
    expect(diagnostics.result?.structuredContent).toMatchObject({
      status: "fresh",
      outbox: { pending: 0, processing: 0, deadLetter: 0 },
    });

    const repairedRead = await client.request(resourceRead(
      7,
      "health://daily-state/2026-08-24",
      runHandle,
    ));
    const repaired = JSON.parse(
      (repairedRead.result?.contents as Array<{ text: string }>)[0]!.text,
    ) as { waterTotalMl: number; projection: { status: string } };
    expect(repaired).toMatchObject({
      waterTotalMl: 222,
      projection: { status: "fresh" },
    });

    const replayAudit = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const [counts] = await replayAudit`
        SELECT
          (SELECT status FROM compass_health.outbox_events
           WHERE aggregate_id = ${waterLogId}) AS repaired_status,
          (SELECT count(*)::int FROM compass_health.outbox_events
           WHERE type = 'projection.replayed'
             AND user_id = (
               SELECT id FROM compass_health.users WHERE external_id = ${externalUserId}
             )
             AND payload_json ->> 'observedOn' = '2026-08-24') AS replay_outbox,
          (SELECT count(*)::int FROM compass_health.interaction_events interaction
           JOIN compass_health.users usr ON usr.id = interaction.user_id
           WHERE usr.external_id = ${externalUserId}
             AND interaction.stage = 'projection_replay'
             AND interaction.stage_code = 'ok') AS operational_audits`;
      expect(counts).toMatchObject({
        repaired_status: "done",
        replay_outbox: 0,
        operational_audits: 1,
      });
    } finally {
      await replayAudit.end({ timeout: 3 });
    }

    const evidence = await client.request(toolCall(8, "health_get_run_evidence", { runHandle }));
    const steps = (evidence.result?.structuredContent as {
      steps: Array<{
        stage: string;
        resourceUri: string | null;
        aggregateType: string | null;
        resultSummary: Record<string, unknown> | null;
      }>;
    }).steps;
    expect(steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: "resource_read",
        resourceUri: "health://daily-state/2026-08-24",
        aggregateType: "daily_state_projection",
        resultSummary: expect.objectContaining({
          localDate: "2026-08-24",
          projectionStatus: "fresh",
          hasState: true,
        }),
      }),
    ]));
  }, 30_000);

  it("rejects Resource Read evidence append after the formal run is closed", async () => {
    const binding = `mcp-wire-closed-evidence-${process.pid}-${Date.now()}`;
    const client = new WireClient({ externalUserId: binding });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire closed evidence",
      idempotencyKey: "wire-closed-evidence-run",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const firstRead = await client.request(resourceRead(2, "health://constraints/active/today", runHandle));
    expect(firstRead.error).toBeUndefined();
    await client.request(toolCall(3, "health_end_run", {
      runHandle,
      outcome: "completed",
      idempotencyKey: "wire-closed-evidence-end",
    }));
    const before = await client.request(toolCall(4, "health_get_run_evidence", { runHandle }));
    const beforeSteps = (before.result?.structuredContent as { steps: unknown[] }).steps;

    const rejected = await client.request(resourceRead(5, "health://daily-state/today", runHandle));
    expect(rejected.error).toBeDefined();
    const after = await client.request(toolCall(6, "health_get_run_evidence", { runHandle }));
    const afterSteps = (after.result?.structuredContent as {
      steps: Array<{ sequence: number }>;
    }).steps;
    expect(afterSteps).toHaveLength(beforeSteps.length);
    expect(new Set(afterSteps.map((step) => step.sequence)).size).toBe(afterSteps.length);
  }, 25_000);

  it("links explicit safety read tools to one formal run without custom Resource meta", async () => {
    const binding = `mcp-wire-explicit-reads-${process.pid}-${Date.now()}`;
    const client = new WireClient({ externalUserId: binding });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire explicit safety reads",
      idempotencyKey: "wire-explicit-reads-run",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const calls: Array<[string, Record<string, unknown>]> = [
      ["health_get_daily_state", { runHandle, date: "2026-08-24" }],
      ["health_get_active_constraints", { runHandle, date: "2026-08-24" }],
      ["health_get_training_cycle", { runHandle }],
      ["health_get_active_plan", { runHandle }],
    ];
    for (const [index, [name, args]] of calls.entries()) {
      const response = await client.request(toolCall(index + 2, name, args));
      expect(response.error, name).toBeUndefined();
      expect(response.result?.resultType, name).toBe("complete");
    }

    const evidence = await client.request(toolCall(6, "health_get_run_evidence", { runHandle }));
    const steps = (evidence.result?.structuredContent as {
      steps: Array<{ mcpName: string | null; resultSummary: Record<string, unknown> | null }>;
    }).steps;
    const names = new Set(steps.map((step) => step.mcpName));
    for (const [name] of calls) expect(names).toContain(name);
    expect(steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mcpName: "health_get_active_constraints",
        resultSummary: expect.objectContaining({
          date: "2026-08-24",
          constraintCount: 0,
        }),
      }),
    ]));
  }, 30_000);

  it("does not leak projection lag or failures across dates", async () => {
    const binding = `mcp-wire-projection-date-${process.pid}-${Date.now()}`;
    const client = new WireClient({ externalUserId: binding });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire projection date isolation",
      idempotencyKey: "wire-run-projection-date",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const water = await client.request(toolCall(2, "health_record_water", {
      runHandle,
      amountMl: 111,
      date: "2026-08-20",
      idempotencyKey: "wire-water-projection-date",
    }));
    const waterLogId = (water.result?.structuredContent as { waterLogId: string }).waterLogId;
    const unaffected = await client.request(resourceRead(
      3,
      "health://daily-state/2026-08-21",
      runHandle,
    ));
    const unaffectedBody = JSON.parse(
      (unaffected.result?.contents as Array<{ text: string }>)[0]!.text,
    ) as { schemaVersion: string; projection: { status: string; materialized: boolean } };
    expect(unaffectedBody.schemaVersion).toBe("daily-health-state.v2");
    expect(unaffectedBody.projection).toMatchObject({ status: "fresh", materialized: false });

    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      await sql`
        UPDATE compass_health.outbox_events
        SET status = 'dead_letter', last_error = 'other-date-failure'
        WHERE aggregate_id = ${waterLogId}`;
    } finally {
      await sql.end({ timeout: 3 });
    }
    const diagnostics = await client.request(toolCall(4, "health_get_projection_diagnostics", {
      runHandle,
      date: "2026-08-21",
    }));
    expect(diagnostics.result?.structuredContent).toMatchObject({
      status: "missing",
      outbox: { pending: 0, deadLetter: 0 },
    });
    const replay = await client.request(toolCall(5, "health_replay_projection", {
      runHandle,
      date: "2026-08-21",
      idempotencyKey: "wire-replay-projection-date",
    }));
    expect(replay.result?.structuredContent).toMatchObject({ revived: 0 });
  }, 25_000);

  it("filters the Constraints Resource by activeFrom and activeTo", async () => {
    const client = new WireClient();
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire constraint date window",
      idempotencyKey: "wire-run-constraint-window",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    let activeId = "";
    let expiredId = "";
    let futureId = "";
    try {
      const [user] = await sql`
        SELECT id FROM compass_health.users WHERE external_id = ${externalUserId}`;
      const rows = await sql`
        INSERT INTO compass_health.health_constraints
          (user_id, constraint_type, severity, target_json, reason, active_from, active_to)
        VALUES
          (${user!.id}::uuid, 'time_limited', 'warn', '{}'::jsonb, 'active-window', '2026-08-01', '2026-08-31'),
          (${user!.id}::uuid, 'time_limited', 'warn', '{}'::jsonb, 'expired-window', '2026-08-01', '2026-08-10'),
          (${user!.id}::uuid, 'time_limited', 'warn', '{}'::jsonb, 'future-window', '2026-09-01', NULL)
        RETURNING id, reason`;
      for (const row of rows) {
        if (row.reason === "active-window") activeId = String(row.id);
        if (row.reason === "expired-window") expiredId = String(row.id);
        if (row.reason === "future-window") futureId = String(row.id);
      }
    } finally {
      await sql.end({ timeout: 3 });
    }

    const response = await client.request(resourceRead(
      2,
      "health://constraints/active/2026-08-25",
      runHandle,
    ));
    const content = (response.result?.contents as Array<{ text: string }>)[0]!;
    const ids = (JSON.parse(content.text) as Array<{ id: string }>).map((constraint) => constraint.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(expiredId);
    expect(ids).not.toContain(futureId);
  }, 20_000);

  it("uses the body profile effective on the diet-plan start date", async () => {
    const binding = `mcp-wire-diet-profile-basis-${process.pid}-${Date.now()}`;
    const client = new WireClient({ externalUserId: binding });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire effective profile diet plan",
      idempotencyKey: "wire-run-effective-profile-plan",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const current = await client.request(toolCall(2, "health_update_body_profile", bodyProfileArgs(
      runHandle,
      "wire-effective-profile-current",
      { effectiveDate: "2026-08-20" },
    )));
    const future = await client.request(toolCall(3, "health_update_body_profile", bodyProfileArgs(
      runHandle,
      "wire-effective-profile-future",
      { effectiveDate: "2026-09-20", weightKg: 84, goalWeightKg: 76 },
    )));
    const currentProfile = (current.result?.structuredContent as {
      profile: { id: string; targetKcal: number };
    }).profile;
    const futureProfile = (future.result?.structuredContent as {
      profile: { id: string; targetKcal: number };
    }).profile;
    expect(currentProfile.id).not.toBe(futureProfile.id);

    const generated = await client.request(toolCall(4, "health_generate_diet_plan", {
      runHandle,
      startDate: "2026-08-26",
      idempotencyKey: "wire-generate-effective-profile-plan",
    }));

    expect(generated.result?.structuredContent).toMatchObject({
      generation: {
        profileBasis: {
          profileId: currentProfile.id,
          effectiveDate: "2026-08-20",
          targetKcal: currentProfile.targetKcal,
          usedDefault: false,
        },
      },
    });
  }, 30_000);

  it("generates and reads back a persisted diet plan", async () => {
    const binding = `mcp-wire-diet-plan-${process.pid}-${Date.now()}`;
    const affectedDates = [
      "2026-08-26",
      "2026-08-27",
      "2026-08-28",
      "2026-08-29",
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
    ];
    const client = new WireClient({ externalUserId: binding });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire J01 diet plan",
      idempotencyKey: "wire-run-diet-plan",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const generated = await client.request(toolCall(2, "health_generate_diet_plan", {
      runHandle,
      startDate: "2026-08-26",
      idempotencyKey: "wire-generate-diet-plan",
    }));
    const generatedBody = generated.result?.structuredContent as {
      startDate: string;
      endDate: string;
      entryCount: number;
      generation: { status: string };
      receiptId: string;
    };
    expect(generatedBody).toMatchObject({
      startDate: "2026-08-26",
      endDate: "2026-09-01",
      generation: { status: "planned" },
    });
    expect(generatedBody.entryCount).toBeGreaterThan(0);
    expect(generatedBody.receiptId).toEqual(expect.any(String));

    const readBack = await client.request(toolCall(3, "health_get_diet_plan", {
      runHandle,
      startDate: generatedBody.startDate,
      endDate: generatedBody.endDate,
    }));
    const readBody = readBack.result?.structuredContent as { entries: Array<{ id: string }> };
    expect(readBody.entries).toHaveLength(generatedBody.entryCount);
    const actual = await client.request(toolCall(30, "health_log_meal", {
      runHandle,
      date: generatedBody.startDate,
      mealType: "lunch",
      description: "牛肉150克",
      items: [{ name: "牛肉", quantity: 150, unit: "克" }],
      resolutionMode: "confirm",
      idempotencyKey: "wire-diet-plan-actual",
    }));
    expect(actual.result?.resultType).toBe("complete");

    const inspection = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const events = await inspection<Array<{ observed_on: string }>>`
        SELECT event.payload_json ->> 'observedOn' AS observed_on
        FROM compass_health.outbox_events event
        JOIN compass_health.users app_user ON app_user.id = event.user_id
        WHERE app_user.external_id = ${binding}
          AND event.type = 'diet_plan.changed'
        ORDER BY event.payload_json ->> 'observedOn'`;
      expect(events.map((event) => event.observed_on)).toEqual(affectedDates);
    } finally {
      await inspection.end({ timeout: 3 });
    }

    for (const [index, date] of affectedDates.entries()) {
      const replay = await client.request(toolCall(4 + index * 2, "health_replay_projection", {
        runHandle,
        date,
        idempotencyKey: `wire-diet-plan-replay-${date}`,
      }));
      expect(replay.result?.resultType).toBe("complete");
      const stateResponse = await client.request(toolCall(5 + index * 2, "health_get_daily_state", {
        runHandle,
        date,
      }));
      const state = stateResponse.result?.structuredContent as {
        schemaVersion: string;
        localDate: string;
        diet: {
          plannedMeals: Array<{ planDate: string }>;
          actualLogs: Array<{ id: string }>;
          deviation: { caloriesKcal: number };
        };
      };
      expect(state.schemaVersion).toBe("daily-health-state.v2");
      expect(state.localDate).toBe(date);
      expect(state.diet.plannedMeals.length).toBeGreaterThan(0);
      expect(state.diet.plannedMeals.every((meal) => meal.planDate === date)).toBe(true);
      if (date === generatedBody.startDate) {
        expect(state.diet.actualLogs).toHaveLength(1);
        expect(typeof state.diet.deviation.caloriesKcal).toBe("number");
      }
    }
  }, 60_000);

  it("applies the chosen ambiguous food candidate exactly once", async () => {
    const client = new WireClient();
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire ambiguous meal",
      idempotencyKey: "wire-run-ambiguous-meal",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const args = {
      runHandle,
      date: "2026-08-23",
      mealType: "lunch",
      description: "150g rice",
      items: [{ name: "rice", quantity: 150, unit: "g" }],
      resolutionMode: "confirm",
      idempotencyKey: "wire-meal-candidate-once",
    };
    const pending = await client.request(toolCall(2, "health_log_meal", args));
    expect(pending.result?.resultType).toBe("input_required");
    const requestState = pending.result?.requestState as string;
    const requests = pending.result?.inputRequests as Record<string, {
      params: { requestedSchema: { properties: { choice: { enum: string[] } } } };
    }>;
    const requestKey = Object.keys(requests)[0]!;
    const offered = requests[requestKey]!.params.requestedSchema.properties.choice.enum;
    expect(offered.length).toBeGreaterThan(0);
    const chosen = offered[0]!;

    const completed = await client.request(toolCall(3, "health_log_meal", args, {
      requestState,
      inputResponses: {
        [requestKey]: { action: "accept", content: { choice: chosen } },
      },
    }));
    expect(completed.result?.resultType).toBe("complete");
    const body = completed.result?.structuredContent as { dietLogId: string };
    expect(body.dietLogId).toEqual(expect.any(String));

    const reused = await client.request(toolCall(4, "health_log_meal", args, {
      requestState,
      inputResponses: {
        [requestKey]: { action: "accept", content: { choice: chosen } },
      },
    }));
    expect(reused.result?.resultType).toBe("complete");
    expect(reused.result?.structuredContent).toMatchObject({
      dietLogId: body.dietLogId,
      replayed: true,
    });

    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const rows = await sql`
        SELECT log.id, log.ingredients_json
        FROM compass_health.diet_logs log
        JOIN compass_health.users usr ON usr.id = log.user_id
        WHERE usr.external_id = ${externalUserId}
          AND log.idempotency_key = 'wire-meal-candidate-once'`;
      expect(rows).toHaveLength(1);
      const ingredients = rows[0]?.ingredients_json as Array<{ slug: string }>;
      expect(ingredients.map((item) => item.slug)).toEqual([chosen]);
    } finally {
      await sql.end({ timeout: 3 });
    }
  }, 30_000);

  it("logs an explicit Chinese voice breakfast without entering MRTR", async () => {
    const binding = `mcp-wire-chinese-breakfast-${process.pid}-${Date.now()}`;
    const client = new WireClient({ externalUserId: binding });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire Chinese voice breakfast",
      idempotencyKey: "wire-run-chinese-breakfast",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const args = {
      runHandle,
      date: "2026-08-27",
      mealType: "breakfast",
      description: "两个水煮鸡蛋，豆浆不到一升；用户随后确认豆浆为600毫升",
      items: [
        { name: "水煮鸡蛋", quantity: 2, unit: "个" },
        { name: "无糖原味豆浆", quantity: 600, unit: "ml" },
      ],
      resolutionMode: "confirm",
      idempotencyKey: "wire-chinese-breakfast-once",
    };

    const logged = await client.request(toolCall(2, "health_log_meal", args));
    expect(logged.result?.resultType).toBe("complete");
    const body = logged.result?.structuredContent as {
      dietLogId: string;
      receiptId: string;
      replayed: boolean;
    };
    expect(body).toMatchObject({
      dietLogId: expect.any(String),
      receiptId: expect.any(String),
      replayed: false,
    });

    const replayed = await client.request(toolCall(3, "health_log_meal", args));
    expect(replayed.result?.resultType).toBe("complete");
    expect(replayed.result?.structuredContent).toMatchObject({
      dietLogId: body.dietLogId,
      receiptId: body.receiptId,
      replayed: true,
    });

    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const rows = await sql<Array<{
        ingredients_json: Array<{ slug: string; grams: number }>;
        log_count: number;
        pending_count: number;
      }>>`
        SELECT
          log.ingredients_json,
          count(*) OVER ()::int AS log_count,
          (
            SELECT count(*)::int
            FROM compass_health.mcp_pending_input_requests pending
            WHERE pending.run_id = ${runHandle}::uuid
              AND pending.tool_name = 'health_log_meal'
          ) AS pending_count
        FROM compass_health.diet_logs log
        JOIN compass_health.users usr ON usr.id = log.user_id
        WHERE usr.external_id = ${binding}
          AND log.idempotency_key = 'wire-chinese-breakfast-once'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ log_count: 1, pending_count: 0 });
      expect(rows[0]!.ingredients_json).toEqual([
        { slug: "egg", grams: 100 },
        { slug: "soy_milk", grams: 600 },
      ]);
    } finally {
      await sql.end({ timeout: 3 });
    }
  }, 30_000);

  it("lets the Agent record an uncertain colloquial lunch without another user question", async () => {
    const binding = `mcp-wire-colloquial-lunch-${process.pid}-${Date.now()}`;
    const client = new WireClient({ externalUserId: binding });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire Agent-converted colloquial lunch",
      idempotencyKey: "wire-run-colloquial-lunch",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const args = {
      runHandle,
      date: "2026-08-27",
      mealType: "lunch",
      description: "中午吃的一个烧饼，蒜蓉粉丝娃娃菜虾；虾大概是200g带壳，粉丝一把，娃娃菜一个",
      items: [
        { name: "烧饼", quantity: 1, unit: "个" },
        { name: "带壳虾", quantity: 200, unit: "克" },
        { name: "粉丝", quantity: 1, unit: "把" },
        { name: "娃娃菜", quantity: 1, unit: "个" },
      ],
      resolutionMode: "agent_estimate",
      idempotencyKey: "wire-colloquial-lunch-once",
    };

    const logged = await client.request(toolCall(2, "health_log_meal", args));
    expect(logged.result?.resultType).toBe("complete");
    const body = logged.result?.structuredContent as {
      dietLogId: string;
      receiptId: string;
      replayed: boolean;
    };
    expect(body).toMatchObject({
      dietLogId: expect.any(String),
      receiptId: expect.any(String),
      replayed: false,
    });

    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const [row] = await sql<Array<{
        ingredients_json: Array<{ slug: string; grams: number }>;
        uncertain: boolean;
        estimate_confidence: number;
        pending_count: number;
      }>>`
        SELECT
          log.ingredients_json,
          log.uncertain,
          log.estimate_confidence,
          (
            SELECT count(*)::int
            FROM compass_health.mcp_pending_input_requests pending
            WHERE pending.run_id = ${runHandle}::uuid
              AND pending.tool_name = 'health_log_meal'
          ) AS pending_count
        FROM compass_health.diet_logs log
        WHERE log.id = ${body.dietLogId}::uuid`;
      expect(row).toMatchObject({ uncertain: true, estimate_confidence: 0, pending_count: 0 });
      expect(row!.ingredients_json).toEqual(expect.arrayContaining([
        { slug: "烧饼", grams: 100 },
        { slug: "glass_noodles", grams: 50 },
        { slug: "baby_napa", grams: 200 },
      ]));
      expect(row!.ingredients_json).toHaveLength(4);
    } finally {
      await sql.end({ timeout: 3 });
    }
  }, 30_000);

  it("rejects description-only meal calls before they can trigger a user question", async () => {
    const binding = `mcp-wire-description-only-meal-${process.pid}-${Date.now()}`;
    const client = new WireClient({ externalUserId: binding });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire reject legacy description-only meal",
      idempotencyKey: "wire-run-description-only-meal",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;

    const rejected = await client.request(toolCall(2, "health_log_meal", {
      runHandle,
      date: "2026-08-27",
      mealType: "lunch",
      description: "一个烧饼和一把粉丝",
      idempotencyKey: "wire-description-only-meal",
    }));

    expect(rejected.result).toMatchObject({
      resultType: "complete",
      isError: true,
      structuredContent: {
        error: "validation_failed",
        message: "items must be a non-empty Agent-converted array",
      },
    });
  }, 20_000);

  it("keeps an ambiguous meal correction pending until its chosen candidate is confirmed", async () => {
    const binding = `mcp-wire-correct-meal-${process.pid}-${Date.now()}`;
    const client = new WireClient({ externalUserId: binding });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire ambiguous meal correction",
      idempotencyKey: "wire-run-correct-meal",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const logged = await client.request(toolCall(2, "health_log_meal", {
      runHandle,
      date: "2026-08-18",
      mealType: "lunch",
      description: "牛肉150克",
      items: [{ name: "牛肉", quantity: 150, unit: "克" }],
      resolutionMode: "confirm",
      idempotencyKey: "wire-correct-meal-base",
    }));
    const originalLogId = (logged.result?.structuredContent as { dietLogId: string }).dietLogId;
    expect(originalLogId).toEqual(expect.any(String));

    const args = {
      runHandle,
      dietLogId: originalLogId,
      mealType: "lunch",
      description: "150g rice",
      reason: "实际吃的是米饭",
      idempotencyKey: "wire-correct-meal-candidate",
    };
    const pending = await client.request(toolCall(3, "health_correct_meal", args));
    expect(pending.result?.resultType).toBe("input_required");
    const requestState = pending.result?.requestState as string;
    const requests = pending.result?.inputRequests as Record<string, {
      params: { requestedSchema: { properties: { choice: { enum: string[] } } } };
    }>;
    expect(Object.keys(requests)).toEqual(["candidate_0"]);
    const offered = requests.candidate_0!.params.requestedSchema.properties.choice.enum;
    expect(offered.length).toBeGreaterThan(0);
    const chosen = offered.at(-1)!;

    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const [beforeConfirmation] = await sql`
        SELECT
          superseded_by_id,
          (SELECT count(*)::int
             FROM compass_health.diet_logs revision
            WHERE revision.correction_of_id = original.id) AS revision_count,
          (SELECT count(*)::int
             FROM compass_health.mcp_write_receipts receipt
            WHERE receipt.user_id = original.user_id
              AND receipt.tool_name = 'health_correct_meal'
              AND receipt.idempotency_key = 'wire-correct-meal-candidate') AS receipt_count
        FROM compass_health.diet_logs original
        WHERE original.id = ${originalLogId}::uuid`;
      expect(beforeConfirmation).toMatchObject({
        superseded_by_id: null,
        revision_count: 0,
        receipt_count: 0,
      });

      const completed = await client.request(toolCall(4, "health_correct_meal", args, {
        requestState,
        inputResponses: {
          candidate_0: { action: "accept", content: { choice: chosen } },
        },
      }));
      expect(completed.result?.resultType).toBe("complete");
      const body = completed.result?.structuredContent as {
        correctedLogId: string;
        supersededLogId: string;
        receiptId: string;
        replayed: boolean;
      };
      expect(body).toMatchObject({
        correctedLogId: expect.any(String),
        supersededLogId: originalLogId,
        receiptId: expect.any(String),
        replayed: false,
      });

      const reused = await client.request(toolCall(5, "health_correct_meal", args, {
        requestState,
        inputResponses: {
          candidate_0: { action: "accept", content: { choice: chosen } },
        },
      }));
      expect(reused.result?.resultType).toBe("complete");
      expect(reused.result?.structuredContent).toMatchObject({
        correctedLogId: body.correctedLogId,
        supersededLogId: originalLogId,
        receiptId: body.receiptId,
        replayed: true,
      });

      const directReplay = await client.request(toolCall(6, "health_correct_meal", args));
      expect(directReplay.result?.resultType).toBe("complete");
      expect(directReplay.result?.structuredContent).toMatchObject({
        correctedLogId: body.correctedLogId,
        supersededLogId: originalLogId,
        receiptId: body.receiptId,
        replayed: true,
      });

      const [afterConfirmation] = await sql`
        SELECT
          original.superseded_by_id,
          revision.ingredients_json,
          revision.uncertain,
          (SELECT count(*)::int
             FROM compass_health.diet_logs sibling
            WHERE sibling.correction_of_id = original.id) AS revision_count,
          (SELECT count(*)::int
             FROM compass_health.outbox_events event
            WHERE event.aggregate_id = revision.id::text
              AND event.type = 'diet.correct') AS outbox_count,
          (SELECT count(*)::int
             FROM compass_health.mcp_write_receipts receipt
            WHERE receipt.user_id = original.user_id
              AND receipt.tool_name = 'health_correct_meal'
              AND receipt.idempotency_key = 'wire-correct-meal-candidate') AS receipt_count
        FROM compass_health.diet_logs original
        JOIN compass_health.diet_logs revision
          ON revision.id = original.superseded_by_id
        WHERE original.id = ${originalLogId}::uuid`;
      expect(afterConfirmation?.superseded_by_id).toBe(body.correctedLogId);
      expect(afterConfirmation?.ingredients_json).toEqual([{ slug: chosen, grams: 150 }]);
      expect(afterConfirmation).toMatchObject({
        uncertain: false,
        revision_count: 1,
        outbox_count: 1,
        receipt_count: 1,
      });
    } finally {
      await sql.end({ timeout: 3 });
    }
  }, 30_000);

  it("applies independent choices for multiple ambiguous meal segments", async () => {
    const binding = `mcp-wire-multi-meal-${process.pid}-${Date.now()}`;
    const client = new WireClient({ externalUserId: binding });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire multi-item meal confirmation",
      idempotencyKey: "wire-run-multi-meal",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const args = {
      runHandle,
      date: "2026-08-19",
      mealType: "dinner",
      description: "150g rice、100g mystery food",
      items: [
        { name: "rice", quantity: 150, unit: "g" },
        { name: "mystery food", quantity: 100, unit: "g" },
      ],
      resolutionMode: "confirm",
      idempotencyKey: "wire-multi-meal",
    };
    const pending = await client.request(toolCall(2, "health_log_meal", args));
    const requests = pending.result?.inputRequests as Record<string, {
      params: { requestedSchema: { properties: { choice: { enum?: string[] } } } };
    }>;
    expect(Object.keys(requests).sort()).toEqual(["candidate_0", "unmatched_0"]);
    const offered = requests.candidate_0!.params.requestedSchema.properties.choice.enum!;
    const selected = offered[0]!;
    const completed = await client.request(toolCall(3, "health_log_meal", args, {
      requestState: pending.result?.requestState as string,
      inputResponses: {
        candidate_0: { action: "accept", content: { choice: selected } },
        unmatched_0: { action: "accept", content: { choice: "牛肉" } },
      },
    }));
    expect(completed.result?.resultType).toBe("complete");
    const completedBody = completed.result?.structuredContent as {
      dietLogId?: string;
      error?: string;
      message?: string;
    };
    expect(completedBody.error, completedBody.message).toBeUndefined();
    const dietLogId = completedBody.dietLogId;
    expect(dietLogId).toEqual(expect.any(String));
    if (!dietLogId) throw new Error("expected dietLogId after multi-item confirmation");
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const [row] = await sql`
        SELECT ingredients_json FROM compass_health.diet_logs WHERE id = ${dietLogId}::uuid`;
      const slugs = (row!.ingredients_json as Array<{ slug: string }>).map((item) => item.slug);
      expect(slugs).toEqual(expect.arrayContaining([selected, "牛肉"]));
      expect(slugs).toHaveLength(2);
    } finally {
      await sql.end({ timeout: 3 });
    }
  }, 30_000);

  it("isolates the same training-set idempotency key by user and session", async () => {
    const userA = `mcp-wire-set-a-${process.pid}-${Date.now()}`;
    const userB = `mcp-wire-set-b-${process.pid}-${Date.now()}`;
    const clientA = new WireClient({ externalUserId: userA });
    const clientB = new WireClient({ externalUserId: userB });
    clients.push(clientA, clientB);

    async function createSessionAndRecord(
      client: WireClient,
      prefix: string,
    ): Promise<{ setId: string; sessionId: string }> {
      const begun = await client.request(toolCall(1, "health_begin_run", {
        objective: `${prefix} training set scope`,
        idempotencyKey: `${prefix}-run`,
      }));
      const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
      const prepared = await client.request(toolCall(2, "health_prepare_training", {
        runHandle,
        date: "2026-08-22",
        day: "A",
        idempotencyKey: `${prefix}-prepare`,
      }));
      const proposalId = (prepared.result?.structuredContent as { trainingProposalId: string }).trainingProposalId;
      const started = await client.request(toolCall(3, "health_start_training", {
        runHandle,
        trainingProposalId: proposalId,
        date: "2026-08-22",
        dayRole: "A",
        idempotencyKey: `${prefix}-start`,
      }));
      const sessionId = (started.result?.structuredContent as { trainingSessionId: string }).trainingSessionId;
      const resource = await client.request(resourceRead(
        4,
        `health://training/sessions/${sessionId}`,
        runHandle,
      ));
      const content = (resource.result?.contents as Array<{ text: string }>)[0]!;
      const session = JSON.parse(content.text) as {
        exercisesWithSets: Array<{ exercise: { id: string } }>;
      };
      const sessionExerciseId = session.exercisesWithSets[0]!.exercise.id;
      const recorded = await client.request(toolCall(5, "health_record_set", {
        runHandle,
        trainingSessionId: sessionId,
        sessionExerciseId,
        setNumber: 1,
        reps: 8,
        idempotencyKey: "shared-training-set-key",
      }));
      const result = recorded.result?.structuredContent as { setId: string };
      expect(result.setId).toEqual(expect.any(String));
      const readBack = await client.request(resourceRead(
        6,
        `health://training/sessions/${sessionId}`,
        runHandle,
      ));
      const readBackContent = (readBack.result?.contents as Array<{ text: string }>)[0]!;
      const readBackSession = JSON.parse(readBackContent.text) as {
        exercisesWithSets: Array<{ sets: Array<{ id: string }> }>;
      };
      expect(readBackSession.exercisesWithSets.flatMap((exercise) => exercise.sets.map((set) => set.id)))
        .toContain(result.setId);
      return { setId: result.setId, sessionId };
    }

    const first = await createSessionAndRecord(clientA, "wire-set-a");
    const second = await createSessionAndRecord(clientB, "wire-set-b");
    expect(second.setId).not.toBe(first.setId);
    expect(second.sessionId).not.toBe(first.sessionId);

    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const [counts] = await sql`
        SELECT
          count(DISTINCT receipt.user_id)::int AS users,
          count(*)::int AS receipts
        FROM compass_health.mcp_write_receipts receipt
        JOIN compass_health.users usr ON usr.id = receipt.user_id
        WHERE receipt.tool_name = 'health_record_set'
          AND receipt.idempotency_key = 'shared-training-set-key'
          AND usr.external_id IN (${userA}, ${userB})`;
      expect(counts).toMatchObject({ users: 2, receipts: 2 });
    } finally {
      await sql.end({ timeout: 3 });
    }
  }, 45_000);

  it("records per-set feel and escalates pain through the constraint domain path", async () => {
    const binding = `mcp-wire-set-pain-${process.pid}-${Date.now()}`;
    const client = new WireClient({ externalUserId: binding });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire per-set feedback and pain escalation",
      idempotencyKey: "wire-set-pain-run",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const prepared = await client.request(toolCall(2, "health_prepare_training", {
      runHandle,
      date: "2026-08-26",
      day: "A",
      idempotencyKey: "wire-set-pain-prepare",
    }));
    const trainingProposalId = (
      prepared.result?.structuredContent as { trainingProposalId: string }
    ).trainingProposalId;
    const started = await client.request(toolCall(3, "health_start_training", {
      runHandle,
      trainingProposalId,
      date: "2026-08-26",
      dayRole: "A",
      idempotencyKey: "wire-set-pain-start",
    }));
    const trainingSessionId = (
      started.result?.structuredContent as { trainingSessionId: string }
    ).trainingSessionId;
    const initial = await client.request(resourceRead(
      4,
      `health://training/sessions/${trainingSessionId}`,
      runHandle,
    ));
    const initialBody = JSON.parse(
      (initial.result?.contents as Array<{ text: string }>)[0]!.text,
    ) as { exercisesWithSets: Array<{ exercise: { id: string } }> };
    const sessionExerciseId = initialBody.exercisesWithSets[0]!.exercise.id;

    const recorded = await client.request(toolCall(5, "health_record_set", {
      runHandle,
      trainingSessionId,
      sessionExerciseId,
      setNumber: 1,
      reps: 8,
      targetMuscleFeel: 3,
      pain: [{
        bodyPart: "右肩",
        severity: "mild",
        description: "推起时不舒服",
      }],
      idempotencyKey: "wire-set-pain-record",
    }));
    expect(recorded.result?.resultType).toBe("complete");
    expect(recorded.result?.structuredContent).toMatchObject({
      factCommitted: true,
      projectionStatus: "pending",
      projectionRevision: null,
      painEscalated: true,
    });
    expect(recorded.result?.structuredContent).not.toHaveProperty("beforeRevision");
    expect(recorded.result?.structuredContent).not.toHaveProperty("afterRevision");

    const sessionReadBack = await client.request(resourceRead(
      6,
      `health://training/sessions/${trainingSessionId}`,
      runHandle,
    ));
    const sessionBody = JSON.parse(
      (sessionReadBack.result?.contents as Array<{ text: string }>)[0]!.text,
    ) as {
      exercisesWithSets: Array<{
        exercise: { id: string };
        sets: Array<{
          targetMuscleFeel: number | null;
          painJson: Array<{ bodyPart: string; severity: string; description: string }>;
        }>;
      }>;
    };
    const recordedSet = sessionBody.exercisesWithSets
      .find((entry) => entry.exercise.id === sessionExerciseId)!.sets[0]!;
    expect(recordedSet.targetMuscleFeel).toBe(3);
    expect(recordedSet.painJson).toEqual([{
      bodyPart: "右肩",
      severity: "mild",
      description: "推起时不舒服",
    }]);

    const constraintReadBack = await client.request(resourceRead(
      7,
      "health://constraints/active/2026-08-26",
      runHandle,
    ));
    const constraints = JSON.parse(
      (constraintReadBack.result?.contents as Array<{ text: string }>)[0]!.text,
    ) as Array<{
      constraintType: string;
      severity: string;
      targetJson: { bodyPart?: string };
    }>;
    expect(constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        constraintType: "pain",
        severity: "warn",
        targetJson: expect.objectContaining({ bodyPart: "右肩" }),
      }),
    ]));
  }, 35_000);

  it("executes J05 substitution without stacking completed volume", async () => {
    const binding = `mcp-wire-j05-${process.pid}-${Date.now()}`;
    const client = new WireClient({ externalUserId: binding });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire J05 substitution",
      idempotencyKey: "wire-j05-run",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const prepared = await client.request(toolCall(2, "health_prepare_training", {
      runHandle,
      date: "2026-08-18",
      day: "A",
      idempotencyKey: "wire-j05-prepare",
    }));
    const proposalId = (prepared.result?.structuredContent as { trainingProposalId: string }).trainingProposalId;
    const started = await client.request(toolCall(3, "health_start_training", {
      runHandle,
      trainingProposalId: proposalId,
      date: "2026-08-18",
      dayRole: "A",
      idempotencyKey: "wire-j05-start",
    }));
    const sessionId = (started.result?.structuredContent as { trainingSessionId: string }).trainingSessionId;
    const initial = await client.request(resourceRead(4, `health://training/sessions/${sessionId}`, runHandle));
    const initialBody = JSON.parse(
      (initial.result?.contents as Array<{ text: string }>)[0]!.text,
    ) as { exercisesWithSets: Array<{ exercise: { id: string; targetSets: number } }> };
    const original = initialBody.exercisesWithSets[0]!.exercise;
    await client.request(toolCall(5, "health_record_set", {
      runHandle,
      trainingSessionId: sessionId,
      sessionExerciseId: original.id,
      setNumber: 1,
      reps: 8,
      idempotencyKey: "wire-j05-set-1",
    }));
    const proposed = await client.request(toolCall(6, "health_propose_substitution", {
      runHandle,
      trainingSessionId: sessionId,
      sessionExerciseId: original.id,
      reasonCode: "equipment_unavailable",
      unavailableEquipment: ["barbell"],
      availableEquipment: ["dumbbell", "machine", "cable"],
      idempotencyKey: "wire-j05-propose-substitution",
    }));
    const proposal = proposed.result?.structuredContent as {
      substitutionProposalId: string;
      remainingSets: number;
      candidates: Array<{ slug: string; equipment: string | null }>;
    };
    expect(proposal.remainingSets).toBe(original.targetSets - 1);
    expect(proposal.candidates.length).toBeGreaterThan(0);
    expect(proposal.candidates.every((candidate) => candidate.equipment !== "barbell")).toBe(true);
    expect(proposal.candidates.every((candidate) => (
      candidate.equipment !== null && ["dumbbell", "machine", "cable"].includes(candidate.equipment)
    ))).toBe(true);

    const applyArgs = {
      runHandle,
      substitutionProposalId: proposal.substitutionProposalId,
      reason: "equipment occupied",
      idempotencyKey: "wire-j05-apply-substitution",
    };
    const pending = await client.request(toolCall(7, "health_apply_substitution", applyArgs));
    expect(pending.result?.resultType).toBe("input_required");
    const inputRequests = pending.result?.inputRequests as Record<string, {
      params: { requestedSchema: { properties: { choice: { enum?: string[] } } } };
    }>;
    const offered = inputRequests.substitution_choice!.params
      .requestedSchema.properties.choice.enum!;
    expect(offered).toEqual(proposal.candidates.map((candidate) => candidate.slug));
    const chosenSlug = offered[0]!;
    const applied = await client.request(toolCall(8, "health_apply_substitution", applyArgs, {
      requestState: pending.result?.requestState as string,
      inputResponses: {
        substitution_choice: { action: "accept", content: { choice: chosenSlug } },
      },
    }));
    expect(applied.result?.resultType).toBe("complete");
    const replacementId = (applied.result?.structuredContent as { replacementId: string }).replacementId;
    const readBack = await client.request(resourceRead(9, `health://training/sessions/${sessionId}`, runHandle));
    const readBackBody = JSON.parse(
      (readBack.result?.contents as Array<{ text: string }>)[0]!.text,
    ) as {
      exercisesWithSets: Array<{
        exercise: { id: string; replacementForId: string | null; targetSets: number };
        sets: Array<{ id: string }>;
      }>;
    };
    const replacement = readBackBody.exercisesWithSets.find((entry) => entry.exercise.id === replacementId)!;
    const originalReadBack = readBackBody.exercisesWithSets.find((entry) => entry.exercise.id === original.id)!;
    expect(replacement.exercise.replacementForId).toBe(original.id);
    expect(replacement.exercise.targetSets).toBe(proposal.remainingSets);
    expect(originalReadBack.sets).toHaveLength(1);

    const replay = await client.request(toolCall(10, "health_replay_projection", {
      runHandle,
      date: "2026-08-18",
      idempotencyKey: "wire-j05-replay",
    }));
    expect(replay.result?.resultType).toBe("complete");
    const daily = await client.request(toolCall(11, "health_get_daily_state", {
      runHandle,
      date: "2026-08-18",
    }));
    const dailyState = daily.result?.structuredContent as {
      training: {
        activeSessionId: string;
        plannedSetBudget: number;
        completedSetBudget: number;
        substitutions: Array<{
          originalExerciseId: string;
          replacementExerciseId: string;
          inheritedSetBudget: number;
        }>;
      };
      userDecisions: Array<{ decisionType: string; subject: { type?: string; to?: string } }>;
    };
    expect(dailyState.training.activeSessionId).toBe(sessionId);
    expect(dailyState.training.completedSetBudget)
      .toBeLessThanOrEqual(dailyState.training.plannedSetBudget);
    expect(dailyState.training.substitutions).toContainEqual(expect.objectContaining({
      originalExerciseId: original.id,
      replacementExerciseId: replacementId,
      inheritedSetBudget: proposal.remainingSets,
    }));
    expect(dailyState.userDecisions).toContainEqual(expect.objectContaining({
      decisionType: "accepted",
      subject: expect.objectContaining({ type: "exercise_substitution", to: chosenSlug }),
    }));
  }, 35_000);

  it("executes J03 low sleep -> REST -> acknowledgement without changing the active plan", async () => {
    const binding = `mcp-wire-j03-${process.pid}-${Date.now()}`;
    const date = "2026-08-18";
    const client = new WireClient({
      externalUserId: binding,
      testNow: `${date}T04:00:00.000Z`,
    });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire J03 rest acknowledgement",
      idempotencyKey: "wire-j03-run",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;

    // Establish an active plan through the public tool path, then snapshot it.
    const prepared = await client.request(toolCall(2, "health_prepare_training", {
      runHandle,
      date,
      day: "A",
      idempotencyKey: "wire-j03-plan-setup",
    }));
    expect(prepared.result?.resultType).toBe("complete");
    const planBeforeResponse = await client.request(toolCall(3, "health_get_active_plan", { runHandle }));
    const planBefore = planBeforeResponse.result?.structuredContent as {
      active: boolean;
      version: { id: string; contentJson: unknown };
    };
    expect(planBefore.active).toBe(true);

    const sleep = await client.request(toolCall(4, "health_record_sleep", {
      runHandle,
      date,
      hours: 4.5,
      idempotencyKey: "wire-j03-low-sleep",
    }));
    expect(sleep.result?.structuredContent).toMatchObject({ hours: 4.5 });

    const replay = await client.request(toolCall(40, "health_replay_projection", {
      runHandle,
      date,
      idempotencyKey: "wire-j03-replay",
    }));
    expect(replay.result?.resultType).toBe("complete");
    const daily = await client.request(toolCall(41, "health_get_daily_state", { runHandle, date }));
    const dailyState = daily.result?.structuredContent as {
      body: { effectiveSleep: { valueJson: { hours: number } } };
      training: { recommendation: { decision: string; reasonCodes: string[] } };
      plans: { trainingPlanVersionId: string | null };
    };
    expect(dailyState.body.effectiveSleep.valueJson.hours).toBe(4.5);
    expect(dailyState.training.recommendation.decision).toBe("REST");
    expect(dailyState.training.recommendation.reasonCodes).toContain("sleep_low");
    expect(dailyState.plans.trainingPlanVersionId).toBe(planBefore.version.id);

    const cycleBefore = await client.request(toolCall(5, "health_get_training_cycle", { runHandle }));
    const cycleDecision = (cycleBefore.result?.structuredContent as {
      decision: { decision: string; reasonCodes: string[]; positionIndex: number };
    }).decision;
    expect(cycleDecision).toMatchObject({ decision: "REST", positionIndex: 0 });
    expect(cycleDecision.reasonCodes).toContain("sleep_low");

    const acknowledged = await client.request(toolCall(6, "health_acknowledge_rest", {
      runHandle,
      date,
      idempotencyKey: "wire-j03-rest",
    }));
    expect(acknowledged.result?.structuredContent).toMatchObject({
      acknowledged: true,
      positionIndex: 0,
      status: "skipped_readiness",
    });

    const planAfterResponse = await client.request(toolCall(7, "health_get_active_plan", { runHandle }));
    const planAfter = planAfterResponse.result?.structuredContent as {
      active: boolean;
      version: { id: string; contentJson: unknown };
    };
    expect(planAfter.version.id).toBe(planBefore.version.id);
    expect(planAfter.version.contentJson).toEqual(planBefore.version.contentJson);

    const cycleAfter = await client.request(toolCall(8, "health_get_training_cycle", { runHandle }));
    const positions = (cycleAfter.result?.structuredContent as {
      positions: Array<{ positionIndex: number; positionRole: string; status: string }>;
    }).positions;
    expect(positions).toContainEqual(expect.objectContaining({
      positionIndex: 0,
      positionRole: "A",
      status: "skipped_readiness",
    }));
  }, 20_000);

  it("records terminal evidence for validation, stale, ownership, conflict, safety, and projection failures", async () => {
    const binding = `mcp-wire-failure-evidence-${process.pid}-${Date.now()}`;
    const otherBinding = `${binding}-other`;
    testExternalUserIds.add(otherBinding);
    const date = "2026-08-21";
    const client = new WireClient({
      externalUserId: binding,
      testNow: `${date}T04:00:00.000Z`,
    });
    clients.push(client);

    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire terminal failure evidence matrix",
      idempotencyKey: "wire-failure-evidence-run",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const prepared = await client.request(toolCall(2, "health_prepare_training", {
      runHandle,
      date,
      day: "A",
      idempotencyKey: "wire-failure-prepare-expired",
    }));
    const proposalId = (
      prepared.result?.structuredContent as { trainingProposalId: string }
    ).trainingProposalId;

    const setup = postgres(DATABASE_URL, { max: 1, prepare: false });
    let otherConstraintId = "";
    let supersededDietLogId = "";
    try {
      const [user] = await setup`
        SELECT id FROM compass_health.users WHERE external_id = ${binding}`;
      const [other] = await setup`
        INSERT INTO compass_health.users (external_id, locale, timezone)
        VALUES (${otherBinding}, 'zh', 'Asia/Shanghai')
        RETURNING id`;
      const [otherConstraint] = await setup`
        INSERT INTO compass_health.health_constraints
          (user_id, constraint_type, severity, target_json, reason, active_from)
        VALUES
          (${other!.id}::uuid, 'pain', 'block', '{"bodyPart":"shoulder"}'::jsonb,
           'cross-user fixture', ${date})
        RETURNING id`;
      otherConstraintId = String(otherConstraint!.id);
      const [originalDietLog] = await setup`
        INSERT INTO compass_health.diet_logs
          (user_id, log_date, meal_type, description)
        VALUES (${user!.id}::uuid, ${date}, 'snack', 'original conflict fixture')
        RETURNING id`;
      const [revisedDietLog] = await setup`
        INSERT INTO compass_health.diet_logs
          (user_id, log_date, meal_type, description, correction_of_id)
        VALUES (${user!.id}::uuid, ${date}, 'snack', 'revised conflict fixture', ${originalDietLog!.id}::uuid)
        RETURNING id`;
      await setup`
        UPDATE compass_health.diet_logs
        SET superseded_by_id = ${revisedDietLog!.id}::uuid
        WHERE id = ${originalDietLog!.id}::uuid`;
      supersededDietLogId = String(originalDietLog!.id);
      await setup`
        UPDATE compass_health.prepared_training_proposals
        SET expires_at = ${new Date("2026-08-20T00:00:00.000Z")}
        WHERE id = ${proposalId}::uuid AND user_id = ${user!.id}::uuid`;
    } finally {
      await setup.end({ timeout: 3 });
    }

    const invalidSet = await client.request(toolCall(3, "health_record_set", {
      runHandle,
      trainingSessionId: "00000000-0000-4000-8000-000000000001",
      sessionExerciseId: "00000000-0000-4000-8000-000000000002",
      setNumber: 0,
      reps: -1,
      idempotencyKey: "wire-failure-invalid-set",
    }));
    expect(invalidSet.result?.structuredContent).toMatchObject({ error: "validation_failed" });

    const stale = await client.request(toolCall(4, "health_start_training", {
      runHandle,
      trainingProposalId: proposalId,
      date,
      dayRole: "A",
      idempotencyKey: "wire-failure-expired-proposal",
    }));
    expect(stale.result?.structuredContent).toMatchObject({ error: "proposal_stale" });

    const crossUser = await client.request(toolCall(5, "health_lift_constraint", {
      runHandle,
      constraintId: otherConstraintId,
      idempotencyKey: "wire-failure-cross-user",
    }));
    expect(crossUser.result?.structuredContent).toMatchObject({ error: "not_found" });

    const conflict = await client.request(toolCall(6, "health_correct_meal", {
      runHandle,
      dietLogId: supersededDietLogId,
      description: "牛肉150克",
      idempotencyKey: "wire-failure-state-conflict",
    }));
    expect(conflict.result?.structuredContent).toMatchObject({ error: "state_conflict" });

    const poison = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const [user] = await poison`
        SELECT id FROM compass_health.users WHERE external_id = ${binding}`;
      await poison`
        INSERT INTO compass_health.health_constraints
          (user_id, constraint_type, severity, target_json, reason, active_from, active_to)
        VALUES
          (${user!.id}::uuid, 'medical', 'block', '{"movementPattern":"horizontal_push"}'::jsonb, 'block A horizontal', ${date}, ${date}),
          (${user!.id}::uuid, 'medical', 'block', '{"movementPattern":"vertical_push"}'::jsonb, 'block A vertical', ${date}, ${date}),
          (${user!.id}::uuid, 'medical', 'block', '{"movementPattern":"elbow_extension"}'::jsonb, 'block A elbow', ${date}, ${date}),
          (${user!.id}::uuid, 'medical', 'block', '{"movementPattern":"lateral_raise"}'::jsonb, 'block A lateral', ${date}, ${date})`;
      await poison`
        INSERT INTO compass_health.outbox_events
          (user_id, aggregate_type, aggregate_id, type, payload_json)
        VALUES
          (${user!.id}::uuid, 'unsupported_failure_fixture', 'wire-projection-poison',
           'fixture.unsupported', ${poison.json({ observedOn: date })})`;
    } finally {
      await poison.end({ timeout: 3 });
    }

    const safety = await client.request(toolCall(7, "health_prepare_training", {
      runHandle,
      date,
      day: "A",
      idempotencyKey: "wire-failure-safety-block",
    }));
    expect(safety.result?.structuredContent).toMatchObject({ error: "health_safety_block" });

    const projection = await client.request(toolCall(8, "health_replay_projection", {
      runHandle,
      date,
      idempotencyKey: "wire-failure-projection",
    }));
    expect(projection.result?.structuredContent).toMatchObject({ error: "domain_unavailable" });

    const wrongTool = await client.request(toolCall(9, "health_record_sets", { runHandle }));
    expect(wrongTool.result?.structuredContent).toMatchObject({ error: "tool_not_found" });

    const evidence = await client.request(toolCall(10, "health_get_run_evidence", { runHandle }));
    const terminalFailures = (evidence.result?.structuredContent as {
      steps: Array<{
        stage: string;
        mcpName: string | null;
        status: string | null;
        errorCode: string | null;
        failureStage: string | null;
      }>;
    }).steps.filter((step) => step.stage === "tool_result" && step.errorCode !== null);
    const byTool = new Map(terminalFailures.map((step) => [step.mcpName, step]));
    expect(byTool.get("health_record_set")).toMatchObject({
      status: "failed", errorCode: "validation_failed", failureStage: "validation",
    });
    expect(byTool.get("health_start_training")).toMatchObject({
      status: "refused", errorCode: "proposal_stale", failureStage: "precondition",
    });
    expect(byTool.get("health_lift_constraint")).toMatchObject({
      status: "refused", errorCode: "not_found", failureStage: "target_lookup",
    });
    expect(byTool.get("health_correct_meal")).toMatchObject({
      status: "refused", errorCode: "state_conflict", failureStage: "precondition",
    });
    expect(byTool.get("health_prepare_training")).toMatchObject({
      status: "refused", errorCode: "health_safety_block", failureStage: "safety",
    });
    expect(byTool.get("health_replay_projection")).toMatchObject({
      status: "failed", errorCode: "domain_unavailable", failureStage: "projection",
    });
    expect(byTool.get("health_record_sets")).toMatchObject({
      status: "failed", errorCode: "tool_not_found", failureStage: "tool_lookup",
    });
  }, 40_000);

  it("executes J06 with a playable time-window Range stream and no local-path leak", async () => {
    const binding = `mcp-wire-j06-${process.pid}-${Date.now()}`;
    const marker = `wire-j06-${process.pid}-${Date.now()}`;
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    const segmentIds = new Map<string, string>();
    testMediaPath = join(tmpdir(), `compass-health-wire-media-${process.pid}-${Date.now()}.mp4`);
    await generateTestVideo(testMediaPath);
    const mediaByteLength = (await stat(testMediaPath)).size;
    const fixtures = [
      {
        key: "curun-confirmed",
        trainer: "curun",
        sourceRole: "chest_specialist",
        reviewStatus: "confirmed",
        helpfulCount: 0,
        probeStatus: "ok",
        fullDecodeStatus: "ok",
        decodeErrorAtMs: null,
        usableVideoUntilMs: 60_000,
        startMs: 1_000,
        endMs: 5_000,
      },
      {
        key: "tanchengyi-confirmed",
        trainer: "tanchengyi",
        sourceRole: "technique_details",
        reviewStatus: "confirmed",
        helpfulCount: 0,
        probeStatus: "ok",
        fullDecodeStatus: "ok",
        decodeErrorAtMs: null,
        usableVideoUntilMs: 60_000,
        startMs: 6_000,
        endMs: 10_000,
      },
      {
        key: "curun-draft-popular",
        trainer: "curun",
        sourceRole: "chest_specialist",
        reviewStatus: "draft",
        helpfulCount: 100,
        probeStatus: "ok",
        fullDecodeStatus: "ok",
        decodeErrorAtMs: null,
        usableVideoUntilMs: 60_000,
        startMs: 11_000,
        endMs: 15_000,
      },
      {
        key: "curun-corrupt-tail",
        trainer: "curun",
        sourceRole: "chest_specialist",
        reviewStatus: "confirmed",
        helpfulCount: 0,
        probeStatus: "ok",
        fullDecodeStatus: "decode_errors",
        decodeErrorAtMs: 3_000,
        usableVideoUntilMs: 3_000,
        startMs: 4_000,
        endMs: 5_000,
      },
      {
        key: "curun-unprobed",
        trainer: "curun",
        sourceRole: "chest_specialist",
        reviewStatus: "confirmed",
        helpfulCount: 0,
        probeStatus: "ok",
        fullDecodeStatus: "unprobed",
        decodeErrorAtMs: null,
        usableVideoUntilMs: 60_000,
        startMs: 16_000,
        endMs: 20_000,
      },
      {
        key: "curun-unreadable",
        trainer: "curun",
        sourceRole: "chest_specialist",
        reviewStatus: "confirmed",
        helpfulCount: 0,
        probeStatus: "unreadable",
        fullDecodeStatus: "ok",
        decodeErrorAtMs: null,
        usableVideoUntilMs: 60_000,
        startMs: 21_000,
        endMs: 25_000,
      },
    ] as const;
    try {
      for (const fixture of fixtures) {
        const [asset] = await sql`
          INSERT INTO compass_health.media_assets
            (kind, trainer, source_role, title, local_path, sha256, duration_ms,
             probe_status, full_decode_status, decode_error_at_ms,
             usable_video_until_ms, content_type, bytes)
          VALUES
            ('video', ${fixture.trainer}, ${fixture.sourceRole}, ${`${marker}-${fixture.key}`},
             ${testMediaPath}, ${`${marker}-${fixture.key}`}, 60000,
             ${fixture.probeStatus}, ${fixture.fullDecodeStatus}, ${fixture.decodeErrorAtMs},
             ${fixture.usableVideoUntilMs}, 'video/mp4', ${mediaByteLength})
          RETURNING id`;
        testMediaAssetIds.add(String(asset!.id));
        const [pairing] = await sql`
          INSERT INTO compass_health.media_pairings
            (video_asset_id, match_method, completeness, subtitle_end_ms, usable_until_ms)
          VALUES (${asset!.id}::uuid, 'manifest', 'complete', 60000, 60000)
          RETURNING id`;
        const [segment] = await sql`
          INSERT INTO compass_health.video_segments
            (pairing_id, start_ms, end_ms, trainer, source_role, title, body_part,
             movement_pattern, exercise_slug, category, cues_text, review_status,
             helpful_count)
          VALUES
            (${pairing!.id}::uuid, ${fixture.startMs}, ${fixture.endMs},
             ${fixture.trainer}, ${fixture.sourceRole}, ${`${marker}-${fixture.key}`},
             'chest', 'horizontal_push', 'barbell-bench-press', 'correction',
             ${`${marker} bench chest correction cue`}, ${fixture.reviewStatus},
             ${fixture.helpfulCount})
          RETURNING id`;
        segmentIds.set(fixture.key, String(segment!.id));
      }
    } finally {
      await sql.end({ timeout: 3 });
    }

    const client = new WireClient({ externalUserId: binding, mediaRuntime: "embedded" });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire J06 media",
      idempotencyKey: "wire-j06-run",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const searchArgs = {
      runHandle,
      text: marker,
      movementPattern: "horizontal_push",
      bodyPart: "chest",
      category: "correction",
      limit: 10,
    };
    const searched = await client.request(toolCall(2, "health_search_training_media", searchArgs));
    const segments = (searched.result?.structuredContent as {
      segments: Array<{
        segmentId: string;
        trainer: string;
        sourceRole: string;
        reviewStatus: string;
        streamUrl: string;
        expiresAt: string;
        contentType: string;
        startMs: number;
        endMs: number;
        localPath?: string;
      }>;
    }).segments;
    const ids = segments.map((segment) => segment.segmentId);
    expect(ids).not.toContain(segmentIds.get("curun-corrupt-tail"));
    expect(ids).not.toContain(segmentIds.get("curun-unprobed"));
    expect(ids).not.toContain(segmentIds.get("curun-unreadable"));
    expect(ids.slice(0, 2)).toEqual([
      segmentIds.get("curun-confirmed"),
      segmentIds.get("tanchengyi-confirmed"),
    ]);
    expect(ids.indexOf(segmentIds.get("curun-draft-popular")!)).toBeGreaterThan(1);
    expect(segments[0]).toMatchObject({
      trainer: "curun",
      sourceRole: "chest_specialist",
      reviewStatus: "confirmed",
      contentType: "video/mp4",
      startMs: 1_000,
      endMs: 5_000,
    });
    const streamUrl = new URL(segments[0]!.streamUrl);
    expect(streamUrl.hostname).toBe("127.0.0.1");
    expect(streamUrl.pathname).toBe(`/api/v1/media/segments/${segmentIds.get("curun-confirmed")}/stream`);
    expect(streamUrl.searchParams.get("expires")).toEqual(expect.any(String));
    expect(streamUrl.searchParams.get("signature")).toEqual(expect.any(String));
    expect(new Date(segments[0]!.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(segments.every((segment) => segment.localPath === undefined)).toBe(true);

    const streamed = await fetch(segments[0]!.streamUrl, {
      headers: { Range: "bytes=0-" },
    });
    expect(streamed.status).toBe(206);
    expect(streamed.headers.get("content-type")).toBe("video/mp4");
    expect(streamed.headers.get("accept-ranges")).toBe("bytes");
    const rendered = Buffer.from(await streamed.arrayBuffer());
    const contentRange = /^bytes 0-(\d+)\/(\d+)$/u.exec(streamed.headers.get("content-range") ?? "");
    expect(contentRange?.[1]).toBe(String(rendered.byteLength - 1));
    expect(contentRange?.[2]).toBe(String(rendered.byteLength));
    expect(rendered.subarray(4, 8).toString("ascii")).toBe("ftyp");
    const renderedDuration = await probeVideoDuration(rendered);
    expect(renderedDuration).toBeGreaterThanOrEqual(3.8);
    expect(renderedDuration).toBeLessThanOrEqual(4.2);

    for (let index = 0; index < 3; index += 1) {
      const feedback = await client.request(toolCall(3 + index, "health_record_media_feedback", {
        runHandle,
        segmentId: segmentIds.get("curun-confirmed"),
        helpful: false,
        note: "did not resolve the cue",
        idempotencyKey: `wire-j06-feedback-${index}`,
      }));
      expect(feedback.result?.structuredContent).toMatchObject({
        segmentId: segmentIds.get("curun-confirmed"),
        helpful: false,
      });
    }

    const reranked = await client.request(toolCall(6, "health_search_training_media", searchArgs));
    const rerankedSegments = (reranked.result?.structuredContent as {
      segments: Array<{ segmentId: string; reviewStatus: string }>;
    }).segments;
    const rerankedIds = rerankedSegments.map((segment) => segment.segmentId);
    expect(rerankedIds[0]).toBe(segmentIds.get("tanchengyi-confirmed"));
    expect(rerankedIds.indexOf(segmentIds.get("curun-draft-popular")!)).toBeGreaterThan(1);
  }, 60_000);

  it("executes J07 non-empty plan diff, activation, next prepare, and rollback", async () => {
    const binding = `mcp-wire-j07-${process.pid}-${Date.now()}`;
    const client = new WireClient({ externalUserId: binding });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire J07 plan evolution",
      idempotencyKey: "wire-j07-run",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const prepared = await client.request(toolCall(2, "health_prepare_training", {
      runHandle,
      date: "2026-08-15",
      day: "A",
      idempotencyKey: "wire-j07-prepare",
    }));
    const preparedBody = prepared.result?.structuredContent as {
      trainingProposalId: string;
      proposedExercises: Array<{ exerciseSlug: string }>;
    };
    const proposalId = preparedBody.trainingProposalId;
    const originalOrder = preparedBody.proposedExercises.map((exercise) => exercise.exerciseSlug);
    expect(originalOrder.slice(0, 2)).toEqual([
      "barbell_bench_press",
      "incline_dumbbell_press",
    ]);
    const started = await client.request(toolCall(3, "health_start_training", {
      runHandle,
      trainingProposalId: proposalId,
      date: "2026-08-15",
      dayRole: "A",
      idempotencyKey: "wire-j07-start",
    }));
    const sessionId = (started.result?.structuredContent as { trainingSessionId: string }).trainingSessionId;
    await client.request(toolCall(4, "health_finish_training", {
      runHandle,
      trainingSessionId: sessionId,
      finalStatus: "interrupted",
      idempotencyKey: "wire-j07-finish",
    }));
    const reflected = await client.request(toolCall(5, "health_record_reflection", {
      runHandle,
      trainingSessionId: sessionId,
      bestCueRefs: [],
      proposedAdjustments: [{
        kind: "cue_change",
        target: "barbell_bench_press",
        change: "place incline press first for the next validation",
        reason: "compare upper-chest recruitment while fresh",
        riskLevel: "low",
      }],
      idempotencyKey: "wire-j07-reflection",
    }));
    const reflectionId = (reflected.result?.structuredContent as { reflectionId: string }).reflectionId;
    const governanceSql = postgres(DATABASE_URL, { max: 1, prepare: false });
    let cueSegmentId: string;
    try {
      const [asset] = await governanceSql`
        INSERT INTO compass_health.media_assets
          (kind, trainer, source_role, title, local_path, sha256, duration_ms,
           probe_status, full_decode_status, usable_video_until_ms, content_type, bytes)
        VALUES
          ('video', 'wire-governance', 'technique_details', ${`wire-j07-${binding}`},
           'wire-j07-governance.mp4', ${`wire-j07-${binding}`}, 60000,
           'ok', 'ok', 60000, 'video/mp4', 1)
        RETURNING id`;
      testMediaAssetIds.add(String(asset!.id));
      const [pairing] = await governanceSql`
        INSERT INTO compass_health.media_pairings
          (video_asset_id, match_method, completeness, subtitle_end_ms, usable_until_ms)
        VALUES (${asset!.id}::uuid, 'manifest', 'complete', 60000, 60000)
        RETURNING id`;
      const [segment] = await governanceSql`
        INSERT INTO compass_health.video_segments
          (pairing_id, start_ms, end_ms, trainer, source_role, title, body_part,
           movement_pattern, exercise_slug, category, cues_text, review_status)
        VALUES
          (${pairing!.id}::uuid, 1000, 10000, 'wire-governance', 'technique_details',
           'incline press technique', 'upper_chest', 'horizontal_push',
           'incline_dumbbell_press', 'correction', 'validated incline press cue', 'confirmed')
        RETURNING id`;
      cueSegmentId = String(segment!.id);
    } finally {
      await governanceSql.end({ timeout: 3 });
    }
    const proposed = await client.request(toolCall(6, "health_propose_plan_change", {
      runHandle,
      reflectionId,
       changes: [
         {
           kind: "reorder_exercises",
           dayRole: "A",
           order: ["incline_dumbbell_press", "barbell_bench_press"],
         },
         { kind: "update_sets", dayRole: "A", exerciseSlug: "incline_dumbbell_press", sets: 4 },
         {
           kind: "update_rep_range",
           dayRole: "A",
           exerciseSlug: "incline_dumbbell_press",
           repRangeLow: 6,
           repRangeHigh: 8,
         },
         {
           kind: "update_rir",
           dayRole: "A",
           exerciseSlug: "incline_dumbbell_press",
           rirLow: 1,
           rirHigh: 2,
         },
         {
           kind: "update_cue_refs",
           dayRole: "A",
           exerciseSlug: "incline_dumbbell_press",
           cueRefs: [cueSegmentId],
         },
         { kind: "update_cycle_pattern", cyclePattern: ["A", "REST", "B", "C", "REST"] },
       ],
      reason: "wire J07 validation",
      idempotencyKey: "wire-j07-propose-plan",
    }));
    const proposedBody = proposed.result?.structuredContent as {
      childVersionId: string;
      parentVersionId: string;
       diff: {
         changes: Array<{ kind: string; before: unknown; after: unknown }>;
         changedDays: Array<{ dayRole: string; beforeOrder: string[]; afterOrder: string[] }>;
         cyclePattern: { before: string[]; after: string[] };
       };
    };
    const childVersionId = proposedBody.childVersionId;
    const parentVersionId = proposedBody.parentVersionId;
    const conflictingProposal = await client.request(toolCall(60, "health_propose_plan_change", {
      runHandle,
      reflectionId,
      changes: [{ kind: "update_sets", dayRole: "A", exerciseSlug: "barbell_bench_press", sets: 2 }],
      reason: "same reflection with different arguments",
      idempotencyKey: "wire-j07-proposal-conflict",
    }));
    expect(conflictingProposal.result).toMatchObject({
      resultType: "complete",
      isError: true,
      structuredContent: { error: "proposal_conflict" },
    });
    expect(proposedBody.diff.changedDays).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dayRole: "A",
        beforeOrder: expect.arrayContaining(["barbell_bench_press", "incline_dumbbell_press"]),
        afterOrder: expect.arrayContaining(["incline_dumbbell_press", "barbell_bench_press"]),
      }),
    ]));
    expect(proposedBody.diff.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "update_sets", before: { sets: 3 }, after: { sets: 4 } }),
      expect.objectContaining({ kind: "update_rep_range" }),
      expect.objectContaining({ kind: "update_rir" }),
      expect.objectContaining({ kind: "update_cue_refs" }),
      expect.objectContaining({ kind: "update_cycle_pattern" }),
    ]));
    expect(proposedBody.diff.cyclePattern.after).toEqual(["A", "REST", "B", "C", "REST"]);
    const verify = postgres(DATABASE_URL, { max: 1, prepare: false });
    let parentContentBefore: unknown;
    try {
      const [parent] = await verify`
        SELECT content_json, status FROM compass_health.plan_versions
        WHERE id = ${parentVersionId}::uuid`;
      parentContentBefore = parent?.content_json;
      expect(parent?.status).toBe("active");
    } finally {
      await verify.end({ timeout: 3 });
    }
    const activationArgs = {
      runHandle,
      planVersionId: childVersionId,
      idempotencyKey: "wire-j07-activate",
    };
    const pending = await client.request(toolCall(7, "health_activate_plan_version", activationArgs));
    expect(pending.result?.resultType).toBe("input_required");
    const activationMessage = (((pending.result?.inputRequests as {
      confirmation: { params: { message: string } };
    }).confirmation.params.message));
    expect(activationMessage).toContain("barbell_bench_press");
    expect(activationMessage).toContain("incline_dumbbell_press");
    expect(activationMessage).toContain("beforeOrder");
    expect(activationMessage).toContain("afterOrder");
    expect(activationMessage).toContain("确定性审查");
    expect(activationMessage).toContain("回滚目标");
    expect(activationMessage).toContain("验证问题");
    const activated = await client.request(toolCall(8, "health_activate_plan_version", activationArgs, {
      requestState: pending.result?.requestState as string,
      inputResponses: {
        confirmation: { action: "accept", content: { choice: "确认激活" } },
      },
    }));
    expect(activated.result?.structuredContent).toMatchObject({
      planVersionId: childVersionId,
      activated: true,
      status: "active",
    });

    const nextPrepared = await client.request(toolCall(9, "health_prepare_training", {
      runHandle,
      date: "2026-08-16",
      day: "A",
      idempotencyKey: "wire-j07-prepare-child",
    }));
    const nextBody = nextPrepared.result?.structuredContent as {
      planVersionId: string;
       proposedExercises: Array<{
         exerciseSlug: string;
         sets: number;
         repRangeLow?: number;
         repRangeHigh?: number;
         rirLow?: number;
         rirHigh?: number;
         cueRefs?: string[];
       }>;
    };
    expect(nextBody.planVersionId).toBe(childVersionId);
    expect(nextBody.proposedExercises.slice(0, 2).map((exercise) => exercise.exerciseSlug)).toEqual([
      "incline_dumbbell_press",
      "barbell_bench_press",
    ]);
    expect(nextBody.proposedExercises[0]).toMatchObject({
      sets: 4,
      repRangeLow: 6,
      repRangeHigh: 8,
      rirLow: 1,
      rirHigh: 2,
      cueRefs: [cueSegmentId],
    });

    const postActivation = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const [parent] = await postActivation`
        SELECT content_json, status FROM compass_health.plan_versions
        WHERE id = ${parentVersionId}::uuid`;
      const [child] = await postActivation`
        SELECT content_json, status FROM compass_health.plan_versions
        WHERE id = ${childVersionId}::uuid`;
      expect(parent?.status).toBe("superseded");
      expect(parent?.content_json).toEqual(parentContentBefore);
      expect(child?.status).toBe("active");
      expect(child?.content_json).not.toEqual(parentContentBefore);
    } finally {
      await postActivation.end({ timeout: 3 });
    }

    const rollbackArgs = {
      runHandle,
      planVersionId: parentVersionId,
      idempotencyKey: "wire-j07-rollback-parent",
    };
    const rollbackPending = await client.request(toolCall(10, "health_activate_plan_version", rollbackArgs));
    expect(rollbackPending.result?.resultType).toBe("input_required");
    const rolledBack = await client.request(toolCall(11, "health_activate_plan_version", rollbackArgs, {
      requestState: rollbackPending.result?.requestState as string,
      inputResponses: {
        confirmation: { action: "accept", content: { choice: "确认激活" } },
      },
    }));
    expect(rolledBack.result?.structuredContent).toMatchObject({
      planVersionId: parentVersionId,
      activated: true,
      status: "active",
      direction: "rollback",
      previousVersionId: childVersionId,
    });

    const restored = await client.request(toolCall(12, "health_prepare_training", {
      runHandle,
      date: "2026-08-17",
      day: "A",
      idempotencyKey: "wire-j07-prepare-restored",
    }));
    const restoredBody = restored.result?.structuredContent as {
      planVersionId: string;
      proposedExercises: Array<{ exerciseSlug: string }>;
    };
    expect(restoredBody.planVersionId).toBe(parentVersionId);
    expect(restoredBody.proposedExercises.map((exercise) => exercise.exerciseSlug)).toEqual(originalOrder);
  }, 50_000);
});
