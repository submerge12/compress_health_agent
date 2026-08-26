import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../db/schema.js";
import { assertSchemaReady } from "../db/migrate.js";
import { inspectCodexBinding } from "./codex-binding-readiness.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
const externalUserId = process.env.COMPASS_HEALTH_USER_BINDING?.trim();

if (!databaseUrl || !externalUserId) {
  process.stderr.write(
    "codex:verify-binding requires DATABASE_URL and COMPASS_HEALTH_USER_BINDING\n",
  );
  process.exitCode = 2;
} else {
  const pool = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connection: { default_transaction_read_only: true },
  });
  const db = drizzle(pool, { schema });
  try {
    await assertSchemaReady(databaseUrl);
    const readiness = await inspectCodexBinding(db, externalUserId);
    if (!readiness) {
      process.stderr.write("codex:verify-binding: unknown configured user binding\n");
      process.exitCode = 3;
    } else {
      process.stdout.write(`${JSON.stringify(readiness, null, 2)}\n`);
      if (!readiness.readyForRealJourneys) process.exitCode = 4;
    }
  } catch (error) {
    process.stderr.write(
      `codex:verify-binding: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 5;
  } finally {
    await pool.end({ timeout: 5 });
  }
}
