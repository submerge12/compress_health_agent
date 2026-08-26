import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/db/schema.js";
import {
  createRunHandleService,
  redactArguments,
} from "../../src/mcp/evidence/run-handles.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";

const isDbAvailable = await postgres(DATABASE_URL, { max: 1, connect_timeout: 3 })
  .unsafe("SELECT 1")
  .then(() => true)
  .catch(() => false);

describe("run evidence privacy", () => {
  it("recursively redacts sensitive fields inside arrays and nested arrays", () => {
    const sensitiveTerms = [
      "right shoulder sharp pain",
      "reduce pressing volume",
      "bench still hurts",
      "pain worsened on rep three",
      "raw voice transcript",
      "private coach feedback",
    ];
    const redacted = redactArguments({
      pain: [{ bodyPart: "right_shoulder", description: sensitiveTerms[0] }],
      changes: [{ kind: "reduce_sets", reason: sensitiveTerms[1] }],
      unresolvedIssues: [sensitiveTerms[2]],
      painSummary: [{ severity: "sharp", notes: sensitiveTerms[3] }],
      nested: [[{ rawTranscript: sensitiveTerms[4] }]],
      feedback: sensitiveTerms[5],
      safe: { severity: "sharp", setNumber: 3 },
    });

    const serialized = JSON.stringify(redacted);
    for (const term of sensitiveTerms) expect(serialized).not.toContain(term);
    expect(redacted).toMatchObject({
      pain: [{ bodyPart: "right_shoulder", description: expect.stringContaining("<redacted") }],
      changes: [{ kind: "reduce_sets", reason: expect.stringContaining("<redacted") }],
      unresolvedIssues: expect.stringContaining("<redacted"),
      painSummary: expect.stringContaining("<redacted"),
      nested: [[{ rawTranscript: expect.stringContaining("<redacted") }]],
      feedback: expect.stringContaining("<redacted"),
      safe: { severity: "sharp", setNumber: 3 },
    });
  });
});

describe.skipIf(!isDbAvailable)("run evidence concurrency and lifecycle", () => {
  const pool = postgres(DATABASE_URL, { max: 12, prepare: false });
  const db = drizzle(pool, { schema });
  const userIds = new Set<string>();

  afterAll(async () => {
    for (const userId of userIds) {
      await db.delete(schema.outboxEvents).where(eq(schema.outboxEvents.userId, userId));
      await db.delete(schema.agentRuns).where(eq(schema.agentRuns.userId, userId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
    await pool.end({ timeout: 3 });
  });

  it("allocates unique ordered sequences and refuses steps after run closure", async () => {
    const [user] = await db.insert(schema.users).values({
      externalId: `run-evidence-${process.pid}-${Date.now()}`,
    }).returning({ id: schema.users.id });
    expect(user).toBeDefined();
    userIds.add(user!.id);

    const runs = createRunHandleService(db);
    const begun = await runs.beginRun({
      userId: user!.id,
      objective: "concurrent evidence allocation",
    });

    const recorded = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      runs.recordStep({
        userId: user!.id,
        runHandle: begun.runHandle,
        stage: "resource_read",
        mcpMethod: "resources/read",
        resourceUri: `health://test/${index}`,
        aggregateType: "test_resource",
        aggregateId: String(index),
        resultSummary: index === 7
          ? {
              index,
              safe: true,
              pain: [{ description: "private result pain narrative" }],
              changes: [{ reason: "private result adjustment reason" }],
            }
          : { index, safe: true },
      })));
    const allocated = recorded.map((step) => step.sequence);
    expect(new Set(allocated).size).toBe(recorded.length);

    const stored = await db.select().from(schema.agentRunSteps)
      .where(eq(schema.agentRunSteps.runId, begun.runHandle))
      .orderBy(schema.agentRunSteps.sequence);
    expect(stored.map((step) => step.sequence)).toEqual(
      Array.from({ length: 25 }, (_, index) => index),
    );

    const evidence = await runs.getRun(user!.id, begun.runHandle);
    const resultStep = evidence.steps.find((step) => step.aggregateId === "7");
    expect(resultStep).toMatchObject({
      aggregateType: "test_resource",
      aggregateId: "7",
      resultSummary: {
        index: 7,
        safe: true,
        pain: [{ description: expect.stringContaining("<redacted") }],
        changes: [{ reason: expect.stringContaining("<redacted") }],
      },
    });
    expect(JSON.stringify(resultStep)).not.toContain("private result pain narrative");
    expect(JSON.stringify(resultStep)).not.toContain("private result adjustment reason");

    await runs.endRun({
      userId: user!.id,
      runHandle: begun.runHandle,
      outcome: "completed",
    });
    const before = await db.select().from(schema.agentRunSteps)
      .where(eq(schema.agentRunSteps.runId, begun.runHandle));
    await expect(runs.recordStep({
      userId: user!.id,
      runHandle: begun.runHandle,
      stage: "resource_read",
      resourceUri: "health://test/closed",
    })).rejects.toMatchObject({
      code: "run_handle_invalid",
      reason: "closed",
    });
    const after = await db.select().from(schema.agentRunSteps)
      .where(eq(schema.agentRunSteps.runId, begun.runHandle));
    expect(after).toHaveLength(before.length);
  });
});
