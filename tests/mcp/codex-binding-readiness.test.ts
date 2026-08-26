import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/db/schema.js";
import { inspectCodexBinding } from "../../src/mcp/codex-binding-readiness.js";

const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? "";

const isDbAvailable = await databaseAvailable(DATABASE_URL);

async function databaseAvailable(url: string): Promise<boolean> {
  if (url === "") return false;
  const probe = postgres(url, { max: 1, connect_timeout: 3 });
  try {
    await probe.unsafe("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

describe.skipIf(!isDbAvailable)("Codex existing-user binding readiness", () => {
  const pool = postgres(DATABASE_URL, { max: 2, prepare: false });
  const db = drizzle(pool, { schema });
  const externalId = `codex-binding-readiness-${Date.now()}`;
  let userId = "";

  beforeAll(async () => {
    const [user] = await db.insert(schema.users).values({
      externalId,
      locale: "zh",
      timezone: "Asia/Shanghai",
    }).returning({ id: schema.users.id });
    if (!user) throw new Error("binding readiness user insert failed");
    userId = user.id;
  });

  afterAll(async () => {
    await db.delete(schema.dietLogs).where(eq(schema.dietLogs.userId, userId));
    await db.delete(schema.bmrProfiles).where(eq(schema.bmrProfiles.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end({ timeout: 3 });
  });

  it("does not accept an empty synthetic user as a real-use binding", async () => {
    const readiness = await inspectCodexBinding(
      db,
      externalId,
      new Date("2026-08-26T12:00:00.000Z"),
    );

    expect(readiness).toMatchObject({
      locale: "zh",
      timezone: "Asia/Shanghai",
      localDate: "2026-08-26",
      hasProfile: false,
      history: { total: 0 },
      readyForRealJourneys: false,
      blockers: ["profile_missing", "health_history_missing"],
    });
    expect(readiness?.bindingFingerprint).toMatch(/^[a-f0-9]{12}$/);
  });

  it("accepts the exact existing user only after profile and history checks pass", async () => {
    await db.insert(schema.bmrProfiles).values({
      userId,
      sex: "female",
      ageYears: 30,
      heightCm: 165,
      weightKg: 60,
      activityLevel: "moderate",
      goal: "maintain",
      bmrKcal: 1_350,
      tdeeKcal: 2_000,
      targetKcal: 2_000,
      proteinTargetGrams: 100,
      carbsTargetGrams: 220,
      fatTargetGrams: 60,
      effectiveDate: "2026-08-26",
    });
    await db.insert(schema.dietLogs).values({
      userId,
      logDate: "2026-08-26",
      mealType: "lunch",
      description: "synthetic binding readiness fixture",
      source: "test",
    });

    const readiness = await inspectCodexBinding(db, externalId);

    expect(readiness).toMatchObject({
      hasProfile: true,
      history: { dietLogs: 1, total: 1 },
      readyForRealJourneys: true,
      blockers: [],
    });
    expect(await inspectCodexBinding(db, `${externalId}-other`)).toBeNull();
  });
});
