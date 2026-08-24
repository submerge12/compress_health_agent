-- WO-HS-01 / M16 (part 2): food catalog and seasoning tables, previously only
-- created by drizzle-kit push. Idempotent.

CREATE SCHEMA IF NOT EXISTS compass_health;

CREATE TABLE IF NOT EXISTS compass_health.cooking_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    dish_name text NOT NULL,
    description text,
    ingredients_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    seasonings_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    times_cooked integer DEFAULT 0 NOT NULL,
    last_cooked_at timestamp with time zone,
    rating integer,
    notes text,
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
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS compass_health.food_aliases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    alias text NOT NULL,
    locale text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

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

CREATE TABLE IF NOT EXISTS compass_health.meal_compositions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    meal_plan_entry_id uuid,
    diet_log_id uuid,
    food_item_id uuid,
    cooking_record_id uuid,
    component_type text DEFAULT 'food'::text NOT NULL,
    component_name text NOT NULL,
    quantity_grams double precision DEFAULT 0 NOT NULL,
    unit_label text,
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
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS compass_health.natural_units (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    food_item_id uuid,
    food_slug text NOT NULL,
    unit_name text NOT NULL,
    unit_name_zh text,
    grams double precision NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS compass_health.seasonings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    name_zh text,
    serving_unit text DEFAULT 'g'::text NOT NULL,
    serving_grams double precision DEFAULT 1 NOT NULL,
    sodium_mg_per_serving double precision DEFAULT 0 NOT NULL,
    sodium_mg_per_100g double precision DEFAULT 0 NOT NULL,
    calories_kcal_per_100g double precision DEFAULT 0 NOT NULL,
    sugar_grams_per_100g double precision DEFAULT 0 NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS compass_health.user_dishes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    meal_category text NOT NULL,
    role text DEFAULT 'main'::text NOT NULL,
    side_kind text,
    self_contained boolean DEFAULT true NOT NULL,
    ingredients_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    seasonings_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    method text,
    calories_kcal double precision DEFAULT 0 NOT NULL,
    protein_g double precision DEFAULT 0 NOT NULL,
    carbs_g double precision DEFAULT 0 NOT NULL,
    fat_g double precision DEFAULT 0 NOT NULL,
    sodium_mg double precision DEFAULT 0 NOT NULL,
    source text DEFAULT 'user'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS compass_health.user_seasoning_preferences (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    seasoning_id uuid NOT NULL,
    preference text DEFAULT 'neutral'::text NOT NULL,
    max_grams_per_meal double precision,
    avoid boolean DEFAULT false NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE UNIQUE INDEX IF NOT EXISTS "food_aliases_slug_alias_unique" ON compass_health."food_aliases" (slug, alias);


CREATE UNIQUE INDEX IF NOT EXISTS "food_items_slug_unique" ON compass_health."food_items" (slug);


CREATE UNIQUE INDEX IF NOT EXISTS "natural_units_food_slug_unit_name_unique" ON compass_health."natural_units" (food_slug, unit_name);



CREATE UNIQUE INDEX IF NOT EXISTS "seasonings_slug_unique" ON compass_health."seasonings" (slug);


CREATE UNIQUE INDEX IF NOT EXISTS "user_dishes_user_id_slug_unique" ON compass_health."user_dishes" (user_id, slug);


DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cooking_records_user_id_users_id_fk' AND conrelid = 'compass_health.cooking_records'::regclass) THEN
    ALTER TABLE compass_health.cooking_records
      ADD CONSTRAINT cooking_records_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES compass_health.users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meal_compositions_cooking_record_id_cooking_records_id_fk' AND conrelid = 'compass_health.meal_compositions'::regclass) THEN
    ALTER TABLE compass_health.meal_compositions
      ADD CONSTRAINT meal_compositions_cooking_record_id_cooking_records_id_fk FOREIGN KEY (cooking_record_id) REFERENCES compass_health.cooking_records(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meal_compositions_diet_log_id_diet_logs_id_fk' AND conrelid = 'compass_health.meal_compositions'::regclass) THEN
    ALTER TABLE compass_health.meal_compositions
      ADD CONSTRAINT meal_compositions_diet_log_id_diet_logs_id_fk FOREIGN KEY (diet_log_id) REFERENCES compass_health.diet_logs(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meal_compositions_food_item_id_food_items_id_fk' AND conrelid = 'compass_health.meal_compositions'::regclass) THEN
    ALTER TABLE compass_health.meal_compositions
      ADD CONSTRAINT meal_compositions_food_item_id_food_items_id_fk FOREIGN KEY (food_item_id) REFERENCES compass_health.food_items(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meal_compositions_meal_plan_entry_id_meal_plan_entries_id_fk' AND conrelid = 'compass_health.meal_compositions'::regclass) THEN
    ALTER TABLE compass_health.meal_compositions
      ADD CONSTRAINT meal_compositions_meal_plan_entry_id_meal_plan_entries_id_fk FOREIGN KEY (meal_plan_entry_id) REFERENCES compass_health.meal_plan_entries(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meal_compositions_user_id_users_id_fk' AND conrelid = 'compass_health.meal_compositions'::regclass) THEN
    ALTER TABLE compass_health.meal_compositions
      ADD CONSTRAINT meal_compositions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES compass_health.users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'natural_units_food_item_id_food_items_id_fk' AND conrelid = 'compass_health.natural_units'::regclass) THEN
    ALTER TABLE compass_health.natural_units
      ADD CONSTRAINT natural_units_food_item_id_food_items_id_fk FOREIGN KEY (food_item_id) REFERENCES compass_health.food_items(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_dishes_user_id_users_id_fk' AND conrelid = 'compass_health.user_dishes'::regclass) THEN
    ALTER TABLE compass_health.user_dishes
      ADD CONSTRAINT user_dishes_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES compass_health.users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_seasoning_preferences_seasoning_id_seasonings_id_fk' AND conrelid = 'compass_health.user_seasoning_preferences'::regclass) THEN
    ALTER TABLE compass_health.user_seasoning_preferences
      ADD CONSTRAINT user_seasoning_preferences_seasoning_id_seasonings_id_fk FOREIGN KEY (seasoning_id) REFERENCES compass_health.seasonings(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_seasoning_preferences_user_id_users_id_fk' AND conrelid = 'compass_health.user_seasoning_preferences'::regclass) THEN
    ALTER TABLE compass_health.user_seasoning_preferences
      ADD CONSTRAINT user_seasoning_preferences_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES compass_health.users(id) ON DELETE CASCADE;
  END IF;
END $$;
