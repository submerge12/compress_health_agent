/**
 * Canonical user-local date and timezone resolution.
 * Health facts are dated in the bound user's IANA timezone, never by slicing
 * a UTC ISO timestamp. A missing user is an identity error, not a reason to
 * fall back to a different calendar day.
 */
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";

type Db = PostgresJsDatabase<typeof schema>;

export function systemTimezone(): string {
  return process.env["COMPASS_HEALTH_TIMEZONE"] ?? "UTC";
}

/** Format one instant as YYYY-MM-DD in an explicit IANA timezone. */
export function localDateInTimezone(timezone: string, instant: Date = new Date()): string {
  if (Number.isNaN(instant.getTime())) throw new RangeError("instant must be a valid Date");
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
  } catch {
    throw new RangeError(`invalid IANA timezone: ${timezone}`);
  }
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (!value.year || !value.month || !value.day) {
    throw new Error(`could not format local date for timezone: ${timezone}`);
  }
  return `${value.year}-${value.month}-${value.day}`;
}

export function createTimezoneResolver(db: Db) {
  return async function resolveTimezone(userId: string): Promise<string> {
    const [row] = await db.select({ tz: schema.users.timezone })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!row) throw new Error(`user timezone unavailable: ${userId}`);
    const tz = row.tz || systemTimezone();
    // Validate so a bad profile cannot silently date facts in
    // the host timezone.
    localDateInTimezone(tz, new Date(0));
    return tz;
  };
}

/** Canonical resolver used by MCP tools, resources and projection fallbacks. */
export function createUserLocalDateResolver(
  db: Db,
  now: () => Date = () => new Date(),
) {
  const resolveTimezone = createTimezoneResolver(db);
  return async function getUserLocalDate(userId: string, instant: Date = now()): Promise<string> {
    return localDateInTimezone(await resolveTimezone(userId), instant);
  };
}

/** One-shot form for domain callers that do not retain a resolver. */
export async function getUserLocalDate(
  db: Db,
  userId: string,
  instant: Date = new Date(),
): Promise<string> {
  return createUserLocalDateResolver(db, () => instant)(userId, instant);
}
