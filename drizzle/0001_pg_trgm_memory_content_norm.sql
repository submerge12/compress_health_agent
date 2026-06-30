CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "memory_records"
  ADD COLUMN IF NOT EXISTS "content_norm" text DEFAULT '' NOT NULL;

-- Best-effort SQL backfill for existing rows. Runtime writes use the app's
-- NFKC-aware normalizeMemoryText implementation before inserting content_norm.
UPDATE "memory_records"
SET "content_norm" = lower(regexp_replace("content", '[[:punct:][:space:]_]+', '', 'g'))
WHERE "content_norm" = '';

CREATE INDEX IF NOT EXISTS "memory_records_content_norm_trgm_idx"
  ON "memory_records" USING gin ("content_norm" gin_trgm_ops);
