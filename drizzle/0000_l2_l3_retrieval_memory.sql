CREATE SCHEMA IF NOT EXISTS "compass_health";
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE TABLE IF NOT EXISTS "compass_health"."food_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "alias" text NOT NULL,
  "locale" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "food_aliases_slug_alias_unique"
  ON "compass_health"."food_aliases" ("slug", "alias");

-- WO-HS-01: baseline tables that predated the migration system (created
-- historically via drizzle-kit push). Added here so a clean database can run
-- the full chain. All statements are idempotent.

CREATE TABLE IF NOT EXISTS compass_health.food_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    name_zh text,
    category text,
    execution_buckets jsonb DEFAULT '[]'::jsonb NOT NULL,
    roles jsonb DEFAULT '[]'::jsonb NOT NULL,
    weekly_floor integer DEFAULT 0 NOT NULL,
    source text DEFAULT 'csv'::text NOT NULL,
    calories_kcal double precision DEFAULT 0 NOT NULL,
    protein_grams double precision DEFAULT 0 NOT NULL,
    carbs_grams double precision DEFAULT 0 NOT NULL,
    fat_grams double precision DEFAULT 0 NOT NULL,
    fiber_grams double precision DEFAULT 0 NOT NULL,
    sugar_grams double precision DEFAULT 0 NOT NULL,
    sodium_mg double precision DEFAULT 0 NOT NULL,
    potassium_mg double precision DEFAULT 0 NOT NULL,
    calcium_mg double precision DEFAULT 0 NOT NULL,
    iron_mg double precision DEFAULT 0 NOT NULL,
    magnesium_mg double precision DEFAULT 0 NOT NULL,
    zinc_mg double precision DEFAULT 0 NOT NULL,
    vitamin_a_mcg double precision DEFAULT 0 NOT NULL,
    vitamin_c_mg double precision DEFAULT 0 NOT NULL,
    vitamin_d_mcg double precision DEFAULT 0 NOT NULL,
    vitamin_b12_mcg double precision DEFAULT 0 NOT NULL,
    folate_mcg double precision DEFAULT 0 NOT NULL,
    cholesterol_mg double precision DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    allergen_tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    weight_type text DEFAULT 'raw'::text NOT NULL,
    frequency_hint text,
    cooking_difficulty text,
    availability text,
    special_handling_tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    embedding public.vector(1024),
    embedding_text text,
    embedding_model text
);

ALTER TABLE "compass_health"."food_items"
  ADD COLUMN IF NOT EXISTS "execution_buckets" jsonb DEFAULT '[]'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "weekly_floor" integer DEFAULT 0 NOT NULL;

CREATE TABLE IF NOT EXISTS "compass_health"."users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "external_id" text NOT NULL,
  "email" text,
  "display_name" text,
  "locale" text DEFAULT 'en'::text NOT NULL,
  "timezone" text DEFAULT 'UTC'::text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_external_id_unique' AND conrelid = 'compass_health.users'::regclass) THEN
    ALTER TABLE "compass_health"."users" ADD CONSTRAINT users_external_id_unique UNIQUE ("external_id");
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "compass_health"."user_dishes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE cascade,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "meal_category" text NOT NULL,
  "role" text DEFAULT 'main' NOT NULL,
  "side_kind" text,
  "self_contained" boolean DEFAULT true NOT NULL,
  "ingredients_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "seasonings_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "method" text,
  "calories_kcal" double precision DEFAULT 0 NOT NULL,
  "protein_g" double precision DEFAULT 0 NOT NULL,
  "carbs_g" double precision DEFAULT 0 NOT NULL,
  "fat_g" double precision DEFAULT 0 NOT NULL,
  "sodium_mg" double precision DEFAULT 0 NOT NULL,
  "source" text DEFAULT 'user' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_dishes_user_slug_unique"
  ON "compass_health"."user_dishes" ("user_id", "slug");

ALTER TABLE "compass_health"."user_dishes"
  ADD COLUMN IF NOT EXISTS "role" text DEFAULT 'main' NOT NULL,
  ADD COLUMN IF NOT EXISTS "side_kind" text,
  ADD COLUMN IF NOT EXISTS "self_contained" boolean DEFAULT true NOT NULL;

CREATE TABLE IF NOT EXISTS "compass_health"."memory_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "compass_health"."users"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "subject" text NOT NULL,
  "content" text NOT NULL,
  "content_norm" text DEFAULT '' NOT NULL,
  "source_text" text,
  "confidence" double precision DEFAULT 1 NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "superseded_by" uuid,
  "valid_from" timestamp with time zone DEFAULT now() NOT NULL,
  "valid_to" timestamp with time zone,
  "last_confirmed_at" timestamp with time zone DEFAULT now(),
  "times_referenced" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "memory_records_user_status_idx"
  ON "compass_health"."memory_records" ("user_id", "status");

CREATE INDEX IF NOT EXISTS "memory_records_user_kind_subject_idx"
  ON "compass_health"."memory_records" ("user_id", "kind", "subject");

CREATE INDEX IF NOT EXISTS "memory_records_content_norm_trgm_idx"
  ON "compass_health"."memory_records" USING gin ("content_norm" gin_trgm_ops);
