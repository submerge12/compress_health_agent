CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS "food_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "alias" text NOT NULL,
  "locale" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "food_aliases_slug_alias_unique"
  ON "food_aliases" ("slug", "alias");

ALTER TABLE "food_items"
  ADD COLUMN IF NOT EXISTS "execution_buckets" jsonb DEFAULT '[]'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "weekly_floor" integer DEFAULT 0 NOT NULL;

CREATE TABLE IF NOT EXISTS "user_dishes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "meal_category" text NOT NULL,
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
  ON "user_dishes" ("user_id", "slug");

CREATE TABLE IF NOT EXISTS "memory_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "subject" text NOT NULL,
  "content" text NOT NULL,
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
  ON "memory_records" ("user_id", "status");

CREATE INDEX IF NOT EXISTS "memory_records_user_kind_subject_idx"
  ON "memory_records" ("user_id", "kind", "subject");

CREATE INDEX IF NOT EXISTS "memory_records_content_trgm_idx"
  ON "memory_records" USING gin ("content" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "memory_records_subject_trgm_idx"
  ON "memory_records" USING gin ("subject" gin_trgm_ops);
