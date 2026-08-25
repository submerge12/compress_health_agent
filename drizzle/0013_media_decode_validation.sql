-- WO-HS-09 / M23: deep decode validation columns.

ALTER TABLE "compass_health"."media_assets"
  ADD COLUMN IF NOT EXISTS "full_decode_status" text NOT NULL DEFAULT 'unprobed',
  ADD COLUMN IF NOT EXISTS "decode_error_at_ms" integer,
  ADD COLUMN IF NOT EXISTS "usable_video_until_ms" integer;
