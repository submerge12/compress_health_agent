import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";
import { localDateInTimezone } from "../domain/timezone.js";

function argument(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.slice(2).find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length).trim() || undefined;
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() || undefined : undefined;
}

const databaseUrl = process.env.DATABASE_URL?.trim();
const externalId = argument("--external-id");
const timezone = argument("--timezone");
const locale = argument("--locale") ?? "zh";

if (!databaseUrl || !externalId || !timezone) {
  process.stderr.write(
    "usage: DATABASE_URL=... pnpm user:bootstrap --external-id <id> --timezone <IANA zone> [--locale zh|en]\n",
  );
  process.exit(2);
}
if (locale !== "zh" && locale !== "en") {
  process.stderr.write("user:bootstrap: --locale must be zh or en\n");
  process.exit(2);
}
localDateInTimezone(timezone, new Date());

const pool = postgres(databaseUrl, { max: 1, prepare: false });
const db = drizzle(pool, { schema });
try {
  const [existing] = await db.select().from(schema.users)
    .where(eq(schema.users.externalId, externalId))
    .limit(1);
  if (existing) {
    process.stdout.write(`${JSON.stringify({
      status: "exists",
      userId: existing.id,
      externalId: existing.externalId,
      locale: existing.locale,
      timezone: existing.timezone,
    })}\n`);
  } else {
    const [created] = await db.insert(schema.users).values({
      externalId,
      locale,
      timezone,
    }).returning();
    if (!created) throw new Error("user bootstrap insert returned no row");
    process.stdout.write(`${JSON.stringify({
      status: "created",
      userId: created.id,
      externalId: created.externalId,
      locale: created.locale,
      timezone: created.timezone,
    })}\n`);
  }
} finally {
  await pool.end({ timeout: 5 });
}
