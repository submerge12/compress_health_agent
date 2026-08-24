-- WO-HS-01 / M16: core catalog + legacy health tables that were previously only
-- created by `drizzle-kit push` and never captured in a migration file.
-- Without these a clean database cannot reach the required schema version.
-- Idempotent: safe on databases where drizzle-kit push already created them.

CREATE SCHEMA IF NOT EXISTS compass_health;

CREATE TABLE IF NOT EXISTS compass_health.bmr_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    sex text NOT NULL,
    age_years integer NOT NULL,
    height_cm double precision NOT NULL,
    weight_kg double precision NOT NULL,
    activity_level text NOT NULL,
    goal text DEFAULT 'maintain'::text NOT NULL,
    bmr_kcal double precision NOT NULL,
    tdee_kcal double precision NOT NULL,
    target_kcal double precision NOT NULL,
    protein_target_grams double precision DEFAULT 0 NOT NULL,
    carbs_target_grams double precision DEFAULT 0 NOT NULL,
    fat_target_grams double precision DEFAULT 0 NOT NULL,
    effective_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS compass_health.daily_activity_plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    plan_date date NOT NULL,
    target_kcal double precision NOT NULL,
    breakfast_kcal double precision DEFAULT 0 NOT NULL,
    lunch_kcal double precision DEFAULT 0 NOT NULL,
    dinner_kcal double precision DEFAULT 0 NOT NULL,
    snack_kcal double precision DEFAULT 0 NOT NULL,
    water_target_ml integer DEFAULT 2000 NOT NULL,
    exercise_target_minutes integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS compass_health.diet_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    log_date date NOT NULL,
    logged_at timestamp with time zone DEFAULT now() NOT NULL,
    meal_type text NOT NULL,
    description text NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    ingredients_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    seasonings_json jsonb DEFAULT '[]'::jsonb NOT NULL,
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

CREATE TABLE IF NOT EXISTS compass_health.exercise_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    log_date date NOT NULL,
    logged_at timestamp with time zone DEFAULT now() NOT NULL,
    activity_type text NOT NULL,
    duration_minutes integer NOT NULL,
    calories_burned_kcal double precision DEFAULT 0 NOT NULL,
    intensity text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS compass_health.meal_plan_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    plan_date date NOT NULL,
    meal_type text NOT NULL,
    dish_name text NOT NULL,
    recipe_slug text,
    status text DEFAULT 'planned'::text NOT NULL,
    ingredients_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    seasonings_json jsonb DEFAULT '[]'::jsonb NOT NULL,
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

CREATE TABLE IF NOT EXISTS compass_health.physical_conditions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    measured_at timestamp with time zone DEFAULT now() NOT NULL,
    weight_kg double precision,
    body_fat_percent double precision,
    waist_cm double precision,
    resting_heart_rate integer,
    sleep_hours double precision,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS compass_health.water_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    log_date date NOT NULL,
    logged_at timestamp with time zone DEFAULT now() NOT NULL,
    amount_ml integer NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
