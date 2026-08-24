/**
 * WO-HS-05 / M19: timezone resolution — kill the hardcoded Asia/Shanghai.
 * Order (plan §八): user profile timezone → system configured → UTC.
 */
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";

type Db = PostgresJsDatabase<typeof schema>;

export function systemTimezone(): string {
  return process.env["COMPASS_HEALTH_TIMEZONE"] ?? "UTC";
}

export function createTimezoneResolver(db: Db) {
  const cache = new Map<string, string>();

  return async function resolveTimezone(userId: string): Promise<string> {
    const cached = cache.get(userId);
    if (cached !== undefined) return cached;
    let tz = systemTimezone();
    try {
      const [row] = await db.select({ tz: schema.users.timezone })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      if (row?.tz) tz = row.tz;
    } catch {
      // fall back to system timezone on lookup failure
    }
    cache.set(userId, tz);
    return tz;
  };
}
