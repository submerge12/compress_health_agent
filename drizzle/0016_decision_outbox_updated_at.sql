-- P0-2 repair: user_decision_events and outbox_events were declared in
-- schema.ts with the shared created_at/updated_at pair, but 0007 only created
-- created_at. Local databases built via drizzle-kit push never noticed; clean
-- databases built from migrations failed inserts with 42703. 0007 is frozen —
-- the missing columns are added here.

ALTER TABLE "compass_health"."user_decision_events"
    ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();
ALTER TABLE "compass_health"."outbox_events"
    ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();
