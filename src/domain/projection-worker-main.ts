import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../db/schema.js";
import { assertSchemaReady } from "../db/migrate.js";
import { createRepository, type Repository } from "../db/repository.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createProjectionWorker, type ProjectionWorker } from "./projection-worker.js";

type Db = PostgresJsDatabase<typeof schema>;

export interface ProjectionLoopOptions {
  signal: AbortSignal;
  onlyUserId?: string;
  idleDelayMs?: number;
  failureDelayMs?: number;
  onError?: (error: unknown) => void;
}

/** Continuously drains the outbox. Durable leases make restarts and overlap safe. */
export async function runProjectionLoop(
  worker: ProjectionWorker,
  options: ProjectionLoopOptions,
): Promise<void> {
  const idleDelayMs = options.idleDelayMs ?? 250;
  const failureDelayMs = options.failureDelayMs ?? 1_000;
  while (!options.signal.aborted) {
    try {
      const result = await worker.runOnce(undefined, options.onlyUserId);
      if (result.processed === 0) await abortableDelay(idleDelayMs, options.signal);
    } catch (error) {
      options.onError?.(error);
      await abortableDelay(failureDelayMs, options.signal);
    }
  }
}

export function startEmbeddedProjectionWorker(input: {
  db: Db;
  repo: Repository;
  onlyUserId?: string;
  onError?: (error: unknown) => void;
}): { stop: () => Promise<void>; done: Promise<void> } {
  const controller = new AbortController();
  const worker = createProjectionWorker(input.db, input.repo);
  const done = runProjectionLoop(worker, {
    signal: controller.signal,
    ...(input.onlyUserId === undefined ? {} : { onlyUserId: input.onlyUserId }),
    ...(input.onError === undefined ? {} : { onError: input.onError }),
  });
  return {
    done,
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolveDelay) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolveDelay();
    }
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
    ?? "postgres://compass:compass@localhost:5433/compass_health";
  await assertSchemaReady(databaseUrl);
  const pool = postgres(databaseUrl, {
    max: 5,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  const db = drizzle(pool, { schema });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stderr.write("compass-health projection worker: ready\n");
  try {
    await runProjectionLoop(createProjectionWorker(db, createRepository(db)), {
      signal: controller.signal,
      onError: (error) => process.stderr.write(
        `compass-health projection worker: ${error instanceof Error ? error.message : String(error)}\n`,
      ),
    });
  } finally {
    await pool.end({ timeout: 5 });
  }
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `compass-health projection worker: fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
