/**
 * WO-HS-01 / M16: sequential, idempotent SQL migration runner.
 *
 * Design (plan §四):
 * - runs drizzle/00xx_*.sql in filename order inside a per-file transaction;
 * - records applied files in compass_health.schema_migrations so re-running
 *   is a no-op;
 * - files are written idempotently anyway (IF NOT EXISTS / guarded DO blocks)
 *   so a database that was previously set up via `drizzle-kit push` converges
 *   without errors and gets marked as migrated;
 * - refuses to run against a newer schema (downgrade protection).
 *
 * Usage: DATABASE_URL=... pnpm db:migrate
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const MIGRATION_TABLE = "compass_health.schema_migrations";
/** Bump when a new migration lands; the serve.ts gate enforces this. */
export const MIN_SCHEMA_VERSION = 12;

export async function migrate(databaseUrl: string): Promise<{ applied: string[]; skipped: string[] }> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
  try {
    await sql`CREATE SCHEMA IF NOT EXISTS compass_health`;
    await sql`CREATE TABLE IF NOT EXISTS ${sql(MIGRATION_TABLE)} (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;

    const already = new Set(
      (await sql`SELECT name FROM ${sql(MIGRATION_TABLE)}`).map((row) => row.name as string),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    if (files.length === 0) throw new Error(`no migration files found in ${MIGRATIONS_DIR}`);

    const highest = Number(files[files.length - 1]!.slice(0, 4));
    if (highest < MIN_SCHEMA_VERSION) {
      throw new Error(`migration set is older than required version ${MIN_SCHEMA_VERSION}`);
    }

    // Downgrade guard: DB knows migrations this code has never seen.
    for (const name of already) {
      const version = Number(name.slice(0, 4));
      if (!Number.isNaN(version) && !files.includes(name)) {
        throw new Error(`database contains unknown migration "${name}" — refusing to run older code`);
      }
    }

    const applied: string[] = [];
    const skipped: string[] = [];
    for (const file of files) {
      if (already.has(file)) {
        skipped.push(file);
        continue;
      }
      const script = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(MIGRATIONS_DIR, file), "utf8"),
      );
      await sql.begin(async (tx) => {
        await tx.unsafe(script);
        await tx`INSERT INTO ${sql(MIGRATION_TABLE)} (name) VALUES (${file})`;
      });
      applied.push(file);
    }
    return { applied, skipped };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Startup gate: verify connectivity + minimum migration version + the
 * critical objects M03–M08 features depend on. Throws with a human-readable
 * list of what is missing; callers must refuse to start business APIs.
 */
export async function assertSchemaReady(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false, connect_timeout: 5, onnotice: () => undefined });
  try {
    const known = await sql`
      SELECT name FROM ${sql(MIGRATION_TABLE)}
    `.catch(() => [] as Array<{ name: string }>);
    const versions = known.map((r) => Number(String(r.name).slice(0, 4))).filter((n) => !Number.isNaN(n));
    const maxVersion = versions.length > 0 ? Math.max(...versions) : 0;
    if (maxVersion < MIN_SCHEMA_VERSION) {
      throw new Error(
        `schema version ${maxVersion} < required ${MIN_SCHEMA_VERSION}. Run \`pnpm db:migrate\` first.`,
      );
    }

    const requiredObjects: Array<[string, "table" | "column" | "index"]> = [
      ["diet_logs.idempotency_key", "column"],
      ["diet_logs.superseded_by_id", "column"],
      ["diet_logs_user_idempotency_key_uidx", "index"],
      ["health_observation_events", "table"],
      ["health_constraints", "table"],
      ["outbox_events", "table"],
      ["interaction_events", "table"],
      ["daily_health_state_projection", "table"],
      ["plan_versions", "table"],
      ["training_sessions", "table"],
      ["training_set_logs", "table"],
      ["media_assets", "table"],
      ["video_segments", "table"],
      ["prepared_training_proposals", "table"],
    ];
    const missing: string[] = [];
    for (const [name, kind] of requiredObjects) {
      let exists: boolean;
      if (kind === "table") {
        exists = (await sql`
          SELECT 1 FROM information_schema.tables
          WHERE table_schema='compass_health' AND table_name=${name} LIMIT 1`).length > 0;
      } else if (kind === "column") {
        const [tableName, columnName] = name.split(".");
        exists =
          tableName !== undefined && columnName !== undefined &&
          (await sql`
            SELECT 1 FROM information_schema.columns
            WHERE table_schema='compass_health'
              AND table_name=${tableName} AND column_name=${columnName}
            LIMIT 1`).length > 0;
      } else {
        exists = (await sql`
          SELECT 1 FROM pg_indexes
          WHERE schemaname='compass_health' AND indexname=${name} LIMIT 1`).length > 0;
      }
      if (!exists) missing.push(`${kind}:${name}`);
    }
    if (missing.length > 0) {
      throw new Error(`schema gate failed, missing: ${missing.join(", ")}. Run \`pnpm db:migrate\`.`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// CLI entry: `pnpm db:migrate` runs migrations then the startup gate.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";
  migrate(url)
    .then(async ({ applied, skipped }) => {
      console.log(`migrate: applied=${applied.length} skipped=${skipped.length}`);
      for (const name of applied) console.log(`  + ${name}`);
      await assertSchemaReady(url);
      console.log("schema gate: PASS");
    })
    .catch((error: unknown) => {
      console.error(`migrate failed: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    });
}
