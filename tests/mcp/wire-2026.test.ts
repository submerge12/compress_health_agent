import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";
const PROTOCOL_VERSION = "2026-07-28";
const externalUserId = `mcp-wire-${process.pid}-${Date.now()}`;
const testExternalUserIds = new Set([externalUserId]);
const testMediaAssetIds = new Set<string>();
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

  constructor(options: { externalUserId?: string; actor?: string } = {}) {
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
      J01: ["health_generate_diet_plan", "health_get_diet_plan", "health_log_meal"],
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
    expect(names).toContain("health_get_run_evidence");
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
      const drafts = await sql`
        INSERT INTO compass_health.plan_versions
          (user_id, scope, status, parent_version_id, content_json, version_number)
        VALUES
          (${user!.id}::uuid, ${scope}, 'draft', ${parentId}::uuid, '{}'::jsonb, 2),
          (${user!.id}::uuid, ${scope}, 'draft', ${parentId}::uuid, '{}'::jsonb, 3)
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
    const client = new WireClient({ externalUserId: binding });
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
      const scope = `activation-replay-${Date.now()}`;
      const [parent] = await sql`
        INSERT INTO compass_health.plan_versions
          (user_id, scope, status, content_json, version_number)
        VALUES (${user!.id}::uuid, ${scope}, 'active', '{"days":{}}'::jsonb, 1)
        RETURNING id`;
      const [child] = await sql`
        INSERT INTO compass_health.plan_versions
          (user_id, scope, status, parent_version_id, content_json, version_number)
        VALUES (${user!.id}::uuid, ${scope}, 'draft', ${parent!.id}::uuid, '{"days":{}}'::jsonb, 2)
        RETURNING id`;
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
      expect(counts).toMatchObject({ decisions: 1, outbox: 1 });
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
    });
    expect((replayed.result?.structuredContent as { revived: number }).revived).toBeGreaterThan(0);
    const diagnostics = await client.request(toolCall(6, "health_get_projection_diagnostics", {
      date: "2026-08-24",
    }));
    expect(diagnostics.result?.structuredContent).toMatchObject({
      outbox: { deadLetter: 0 },
    });

    const evidence = await client.request(toolCall(7, "health_get_run_evidence", { runHandle }));
    const steps = (evidence.result?.structuredContent as {
      steps: Array<{ stage: string; resourceUri: string | null }>;
    }).steps;
    expect(steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: "resource_read",
        resourceUri: "health://daily-state/2026-08-24",
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
    ) as { projection: { status: string } };
    expect(unaffectedBody.projection.status).toBe("missing");

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

  it("generates and reads back a persisted diet plan", async () => {
    const binding = `mcp-wire-diet-plan-${process.pid}-${Date.now()}`;
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
  }, 30_000);

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
      day: "B",
      idempotencyKey: "wire-j05-prepare",
    }));
    const proposalId = (prepared.result?.structuredContent as { trainingProposalId: string }).trainingProposalId;
    const started = await client.request(toolCall(3, "health_start_training", {
      runHandle,
      trainingProposalId: proposalId,
      date: "2026-08-18",
      dayRole: "B",
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
      idempotencyKey: "wire-j05-propose-substitution",
    }));
    const proposal = proposed.result?.structuredContent as {
      substitutionProposalId: string;
      remainingSets: number;
      candidates: Array<{ slug: string }>;
    };
    expect(proposal.remainingSets).toBe(original.targetSets - 1);
    expect(proposal.candidates.length).toBeGreaterThan(0);
    const applied = await client.request(toolCall(7, "health_apply_substitution", {
      runHandle,
      substitutionProposalId: proposal.substitutionProposalId,
      chosenSlug: proposal.candidates[0]!.slug,
      reason: "equipment occupied",
      idempotencyKey: "wire-j05-apply-substitution",
    }));
    const replacementId = (applied.result?.structuredContent as { replacementId: string }).replacementId;
    const readBack = await client.request(resourceRead(8, `health://training/sessions/${sessionId}`, runHandle));
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
  }, 35_000);

  it("executes J03 REST acknowledgement through the explicit cycle", async () => {
    const binding = `mcp-wire-j03-${process.pid}-${Date.now()}`;
    const client = new WireClient({ externalUserId: binding });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire J03 rest acknowledgement",
      idempotencyKey: "wire-j03-run",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    try {
      const [user] = await sql`SELECT id FROM compass_health.users WHERE external_id = ${binding}`;
      const [cycle] = await sql`
        INSERT INTO compass_health.training_cycle_instances (user_id, status)
        VALUES (${user!.id}::uuid, 'active') RETURNING id`;
      await sql`
        INSERT INTO compass_health.training_cycle_positions
          (cycle_instance_id, user_id, position_index, position_role, status, position_date)
        VALUES
          (${cycle!.id}::uuid, ${user!.id}::uuid, 0, 'A', 'completed', '2026-08-16'),
          (${cycle!.id}::uuid, ${user!.id}::uuid, 1, 'B', 'completed', '2026-08-17')`;
    } finally {
      await sql.end({ timeout: 3 });
    }
    const acknowledged = await client.request(toolCall(2, "health_acknowledge_rest", {
      runHandle,
      date: "2026-08-18",
      idempotencyKey: "wire-j03-rest",
    }));
    expect(acknowledged.result?.structuredContent).toMatchObject({
      acknowledged: true,
      positionIndex: 2,
      status: "skipped_rest",
    });
  }, 20_000);

  it("executes J06 media search and feedback without exposing local paths", async () => {
    const binding = `mcp-wire-j06-${process.pid}-${Date.now()}`;
    const marker = `wire-j06-${process.pid}-${Date.now()}`;
    const sql = postgres(DATABASE_URL, { max: 1, prepare: false });
    let segmentId = "";
    try {
      const [asset] = await sql`
        INSERT INTO compass_health.media_assets
          (kind, trainer, source_role, title, local_path, sha256, duration_ms,
           probe_status, full_decode_status, usable_video_until_ms, content_type, bytes)
        VALUES
          ('video', 'tanchengyi', 'technique_details', ${marker}, 'C:\\private\\fixture.mp4',
           ${marker}, 60000, 'ok', 'ok', 60000, 'video/mp4', 1)
        RETURNING id`;
      testMediaAssetIds.add(String(asset!.id));
      const [pairing] = await sql`
        INSERT INTO compass_health.media_pairings
          (video_asset_id, match_method, completeness, usable_until_ms)
        VALUES (${asset!.id}::uuid, 'manifest', 'complete', 60000)
        RETURNING id`;
      const [segment] = await sql`
        INSERT INTO compass_health.video_segments
          (pairing_id, start_ms, end_ms, trainer, source_role, title, category,
           cues_text, review_status)
        VALUES
          (${pairing!.id}::uuid, 1000, 5000, 'tanchengyi', 'technique_details',
           ${marker}, 'correction', ${`${marker} bench cue`}, 'confirmed')
        RETURNING id`;
      segmentId = String(segment!.id);
    } finally {
      await sql.end({ timeout: 3 });
    }

    const client = new WireClient({ externalUserId: binding });
    clients.push(client);
    const begun = await client.request(toolCall(1, "health_begin_run", {
      objective: "wire J06 media",
      idempotencyKey: "wire-j06-run",
    }));
    const runHandle = (begun.result?.structuredContent as { runHandle: string }).runHandle;
    const searched = await client.request(toolCall(2, "health_search_training_media", {
      text: marker,
      limit: 5,
    }));
    const segments = (searched.result?.structuredContent as {
      segments: Array<{ segmentId: string; streamUrl: string; localPath?: string }>;
    }).segments;
    expect(segments).toEqual(expect.arrayContaining([
      expect.objectContaining({ segmentId, streamUrl: `/api/v1/media/segments/${segmentId}/stream` }),
    ]));
    expect(segments.find((segment) => segment.segmentId === segmentId)?.localPath).toBeUndefined();

    const feedback = await client.request(toolCall(3, "health_record_media_feedback", {
      runHandle,
      segmentId,
      helpful: true,
      note: "clear cue",
      idempotencyKey: "wire-j06-feedback",
    }));
    expect(feedback.result?.structuredContent).toMatchObject({ segmentId, helpful: true });
  }, 25_000);

  it("executes J07 reflection, child proposal, and confirmed activation", async () => {
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
    const proposalId = (prepared.result?.structuredContent as { trainingProposalId: string }).trainingProposalId;
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
      proposedAdjustments: [],
      idempotencyKey: "wire-j07-reflection",
    }));
    const reflectionId = (reflected.result?.structuredContent as { reflectionId: string }).reflectionId;
    const proposed = await client.request(toolCall(6, "health_propose_plan_change", {
      runHandle,
      reflectionId,
      changes: [],
      reason: "wire J07 validation",
      idempotencyKey: "wire-j07-propose-plan",
    }));
    const childVersionId = (proposed.result?.structuredContent as { childVersionId: string }).childVersionId;
    const activationArgs = {
      runHandle,
      planVersionId: childVersionId,
      idempotencyKey: "wire-j07-activate",
    };
    const pending = await client.request(toolCall(7, "health_activate_plan_version", activationArgs));
    expect(pending.result?.resultType).toBe("input_required");
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
  }, 35_000);
});
