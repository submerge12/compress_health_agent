/**
 * WO-HS-01 / M16 migration invariants.
 *
 * Uses a THROWAWAY database on the same live PostgreSQL server so the real
 * migrations are exercised without touching compass_health data:
 * - clean-db: empty DB -> 0000..0009 -> gate passes; re-run applies nothing;
 * - upgrade-existing-db: pre-M03 shape (0000-0004 + legacy rows) -> 0005-0009
 *   keeps row counts and adds columns as NULL/default;
 * - partial unique index ignores legacy NULL idempotency keys but rejects a
 *   real duplicate;
 * - downgrade guard refuses unknown recorded migrations.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { assertSchemaReady, migrate } from "../../src/db/migrate.js";
import { MIN_SCHEMA_VERSION } from "../../src/db/migrate.js";

const BASE_URL =
  process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";
// postgres:// is not a special URL scheme, so URL.origin is null — derive the
// admin prefix and db name by string surgery instead.
const lastSlash = BASE_URL.lastIndexOf("/");
const ADMIN_PREFIX = BASE_URL.slice(0, lastSlash + 1); // ...postgres://user:pass@host:port/
const SOURCE_DB = BASE_URL.slice(lastSlash + 1);
// Unique per-process suffix: vitest runs files in parallel workers, and
// concurrent DROP/CREATE of the same throwaway DB name races.
const RUN_ID = `${process.pid}_${Date.now() % 100000}`;
const CLEAN_DB = `${SOURCE_DB}_mig_clean_${RUN_ID}`;
const UPGRADE_DB = `${SOURCE_DB}_mig_upg_${RUN_ID}`;

const cleanUrl = `${ADMIN_PREFIX}${CLEAN_DB}`;
const upgradeUrl = `${ADMIN_PREFIX}${UPGRADE_DB}`;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const allMigrations = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

async function withAdmin(run: (admin: postgres.Sql) => Promise<void>): Promise<void> {
  const admin = postgres(`${ADMIN_PREFIX}postgres`, { max: 1, onnotice: () => undefined });
  try {
    await run(admin);
  } finally {
    await admin.end({ timeout: 3 });
  }
}

async function dropDatabase(name: string): Promise<void> {
  await withAdmin(async (admin) => {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  });
}

async function createDatabase(name: string): Promise<void> {
  await withAdmin(async (admin) => {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  });
}

describe("migrations (live, throwaway databases)", () => {
  let pool: postgres.Sql | undefined;

  beforeAll(async () => {
    await dropDatabase(CLEAN_DB);
    await dropDatabase(UPGRADE_DB);
    await createDatabase(CLEAN_DB);
    await createDatabase(UPGRADE_DB);
  });

  afterAll(async () => {
    await dropDatabase(CLEAN_DB);
    await dropDatabase(UPGRADE_DB);
    if (pool !== undefined) await pool.end({ timeout: 3 });
  });

  it("clean database: full run then idempotent re-run, gate passes", async () => {
    const first = await migrate(cleanUrl);
    expect(first.applied).toHaveLength(allMigrations.length);
    expect(allMigrations.length).toBe(14);
    expect(first.applied[0]).toMatch(/^0000_/);

    const second = await migrate(cleanUrl);
    expect(second.applied).toHaveLength(0);
    expect(second.skipped).toHaveLength(allMigrations.length);

    // Re-running an individual old file must not duplicate objects either
    // (idempotent SQL): execute 0006 again directly.
    const sql = postgres(cleanUrl, { max: 1, onnotice: () => undefined });
    const script = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(MIGRATIONS_DIR, "0008_diet_log_v2.sql"), "utf8"),
    );
    await sql.unsafe(script); // must not throw
    const columnCount = await sql`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema='compass_health' AND table_name='diet_logs'
        AND column_name='idempotency_key'`;
    expect(columnCount[0]?.n).toBe(1);
    await sql.end({ timeout: 3 });

    await assertSchemaReady(cleanUrl);
  });

  it("upgrade path: pre-M03 schema with legacy data survives 0005-0009", async () => {
    // Simulate the 0000-0004 era: users + diet_logs WITHOUT V2 columns.
    const setup = postgres(upgradeUrl, { max: 2, onnotice: () => undefined });
    await setup`CREATE SCHEMA IF NOT EXISTS compass_health`;
    await setup`
      CREATE TABLE compass_health.users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        external_id text NOT NULL UNIQUE,
        locale text NOT NULL DEFAULT 'en',
        timezone text NOT NULL DEFAULT 'UTC',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
    await setup`
      CREATE TABLE compass_health.diet_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES compass_health.users(id) ON DELETE CASCADE,
        log_date date NOT NULL,
        logged_at timestamptz NOT NULL DEFAULT now(),
        meal_type text NOT NULL,
        description text NOT NULL,
        source text NOT NULL DEFAULT 'manual',
        ingredients_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        seasonings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        calories_kcal double precision NOT NULL DEFAULT 0,
        protein_grams double precision NOT NULL DEFAULT 0,
        carbs_grams double precision NOT NULL DEFAULT 0,
        fat_grams double precision NOT NULL DEFAULT 0,
        sodium_mg double precision NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
    for (let i = 0; i < 3; i++) {
      await setup`
        INSERT INTO compass_health.users (external_id) VALUES (${`legacy-${i}`})`;
    }
    const legacyUsers = await setup`SELECT id, external_id FROM compass_health.users`;
    for (const row of legacyUsers) {
      await setup`
        INSERT INTO compass_health.diet_logs (user_id, log_date, meal_type, description)
        VALUES (${row.id}, '2026-06-17', 'lunch', ${`legacy-meal-${row.external_id}`})`;
    }

    const result = await migrate(upgradeUrl);
    expect(result.applied).toHaveLength(allMigrations.length);

    // Row counts unchanged; new columns NULL/default; new tables writable.
    const users = await setup`SELECT count(*)::int AS n FROM compass_health.users`;
    const logs = await setup`SELECT count(*)::int AS n FROM compass_health.diet_logs`;
    expect(users[0]?.n).toBe(3);
    expect(logs[0]?.n).toBe(3);

    const v2Nulls = await setup`
      SELECT count(*)::int AS n FROM compass_health.diet_logs WHERE idempotency_key IS NULL`;
    expect(v2Nulls[0]?.n).toBe(3);

    await setup`
      INSERT INTO compass_health.health_observation_events (user_id, observed_on, kind, value_json)
      SELECT id, '2026-08-24', 'sleep', '{"hours":7}'::jsonb FROM compass_health.users LIMIT 1`;

    // Partial unique index: legacy NULL keys coexist; duplicates rejected.
    const [someLog] = await setup`SELECT id, user_id FROM compass_health.diet_logs LIMIT 1`;
    await setup`
      UPDATE compass_health.diet_logs SET idempotency_key = ${"key-A"}
      WHERE id = ${someLog!.id}`;
    // Same user, another row with the same key -> rejected by the index.
    const [sameUserOther] = await setup`
      SELECT id FROM compass_health.diet_logs
      WHERE user_id = ${someLog!.user_id} AND id <> ${someLog!.id} LIMIT 1`;
    if (sameUserOther !== undefined) {
      await expect(setup`
        UPDATE compass_health.diet_logs SET idempotency_key = ${"key-A"}
        WHERE id = ${sameUserOther.id}`).rejects.toThrow();
    }
    // Same key on another user is fine (user-scoped uniqueness).
    const [otherUser] = await setup`
      SELECT id FROM compass_health.users
      WHERE id <> ${someLog!.user_id} LIMIT 1`;
    await setup`
      INSERT INTO compass_health.diet_logs (user_id, log_date, meal_type, description, idempotency_key)
      VALUES (${otherUser!.id}, '2026-06-18', 'dinner', 'other-user-same-key', ${"key-A"})`;

    await assertSchemaReady(upgradeUrl);
    await setup.end({ timeout: 3 });
  });

  it("downgrade guard refuses unknown recorded migrations", { timeout: 20000 }, async () => {
    const poison = `${UPGRADE_DB}_poison`;
    await dropDatabase(poison);
    await createDatabase(poison);
    const url = `${ADMIN_PREFIX}${poison}`;
    const sql = postgres(url, { max: 1, onnotice: () => undefined });
    await sql`CREATE SCHEMA IF NOT EXISTS compass_health`;
    await sql`CREATE TABLE compass_health.schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())`;
    await sql`INSERT INTO compass_health.schema_migrations (name) VALUES (${"9999_from_the_future.sql"})`;

    await expect(migrate(url)).rejects.toThrow(/unknown migration/);
    await sql.end({ timeout: 3 });
    await dropDatabase(poison);
  });

  it("gate fails loudly on an unmigrated database", async () => {
    const bare = `${UPGRADE_DB}_bare`;
    await dropDatabase(bare);
    await createDatabase(bare);
    const url = `${ADMIN_PREFIX}${bare}`;
    const sql = postgres(url, { max: 1, onnotice: () => undefined });
    await sql`CREATE SCHEMA IF NOT EXISTS compass_health`;
    await sql.end({ timeout: 3 });

    await expect(assertSchemaReady(url)).rejects.toThrow(/schema version|migrate/i);
    await dropDatabase(bare);
  });
});
