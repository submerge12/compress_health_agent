import "dotenv/config";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

const DEFAULT_DATABASE_URL = "postgres://compass:compass@localhost:5433/compass_health";

function numberFromEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return fallback;
  }

  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function connectionStringFromParts(): string {
  const host = process.env.PGHOST ?? "localhost";
  const port = process.env.PGPORT ?? "5433";
  const database = process.env.PGDATABASE ?? "compass_health";
  const user = encodeURIComponent(process.env.PGUSER ?? "compass");
  const password = encodeURIComponent(process.env.PGPASSWORD ?? "compass");
  return `postgres://${user}:${password}@${host}:${port}/${database}`;
}

function resolveDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl?.trim()) {
    return databaseUrl;
  }

  if (process.env.PGHOST || process.env.PGDATABASE || process.env.PGUSER) {
    return connectionStringFromParts();
  }

  return DEFAULT_DATABASE_URL;
}

export const pool = postgres(resolveDatabaseUrl(), {
  connect_timeout: numberFromEnv("PGCONNECT_TIMEOUT_SECONDS", 10),
  idle_timeout: numberFromEnv("PGIDLE_TIMEOUT_SECONDS", 20),
  max: numberFromEnv("PGPOOL_MAX", 10),
  prepare: false
});

export const db = drizzle(pool, { schema });

let closePromise: Promise<void> | undefined;

export function closeDb(): Promise<void> {
  closePromise ??= pool.end({ timeout: 5 }).then(() => undefined);
  return closePromise;
}

function installGracefulShutdownHandlers(): void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

  for (const signal of signals) {
    process.once(signal, () => {
      void closeDb().finally(() => {
        process.exit(signal === "SIGINT" ? 130 : 0);
      });
    });
  }
}

installGracefulShutdownHandlers();
