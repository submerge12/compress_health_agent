-- WO-HS-01 / M08: media assets, pairings, segments, feedback.

CREATE TABLE IF NOT EXISTS "compass_health"."media_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" text NOT NULL,
  "trainer" text NOT NULL,
  "title" text NOT NULL,
  "local_path" text NOT NULL,
  "sha256" text NOT NULL,
  "duration_ms" integer,
  "probe_status" text NOT NULL DEFAULT 'unprobed',
  "bytes" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_assets_sha_kind_key' AND conrelid = 'compass_health.media_assets'::regclass) THEN
    ALTER TABLE "compass_health"."media_assets"
 ADD CONSTRAINT "media_assets_sha_kind_key" UNIQUE ("sha256", "kind");
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "compass_health"."media_pairings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "video_asset_id" uuid NOT NULL REFERENCES "compass_health"."media_assets"("id") ON DELETE CASCADE,
  "subtitle_asset_id" uuid REFERENCES "compass_health"."media_assets"("id") ON DELETE SET NULL,
  "match_method" text NOT NULL,
  "completeness" text NOT NULL DEFAULT 'unverified',
  "subtitle_end_ms" integer,
  "gap_seconds" integer,
  "usable_until_ms" integer,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_pairings_video_key' AND conrelid = 'compass_health.media_pairings'::regclass) THEN
    ALTER TABLE "compass_health"."media_pairings"
 ADD CONSTRAINT "media_pairings_video_key" UNIQUE ("video_asset_id");
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS "media_pairings_completeness_idx"
  ON "compass_health"."media_pairings" ("completeness");

CREATE TABLE IF NOT EXISTS "compass_health"."video_segments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pairing_id" uuid NOT NULL REFERENCES "compass_health"."media_pairings"("id") ON DELETE CASCADE,
  "start_ms" integer NOT NULL,
  "end_ms" integer NOT NULL,
  "trainer" text NOT NULL,
  "source_role" text NOT NULL,
  "title" text NOT NULL,
  "body_part" text,
  "movement_pattern" text,
  "exercise_slug" text,
  "category" text NOT NULL DEFAULT 'practice',
  "cues_text" text NOT NULL DEFAULT '',
  "review_status" text NOT NULL DEFAULT 'draft',
  "helpful_count" integer NOT NULL DEFAULT 0,
  "not_helpful_count" integer NOT NULL DEFAULT 0,
  "superseded_by_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "video_segments_trainer_idx" ON "compass_health"."video_segments" ("trainer", "category");
CREATE INDEX IF NOT EXISTS "video_segments_pattern_idx" ON "compass_health"."video_segments" ("movement_pattern");
CREATE INDEX IF NOT EXISTS "video_segments_review_idx" ON "compass_health"."video_segments" ("review_status");

CREATE TABLE IF NOT EXISTS "compass_health"."segment_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE CASCADE,
  "segment_id" uuid NOT NULL REFERENCES "compass_health"."video_segments"("id") ON DELETE CASCADE,
  "helpful" boolean NOT NULL,
  "note" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
