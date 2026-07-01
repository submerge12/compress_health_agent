CREATE SCHEMA IF NOT EXISTS "compass_health";

ALTER TABLE "compass_health"."food_items"
  ADD COLUMN IF NOT EXISTS "allergen_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "weight_type" text DEFAULT 'raw' NOT NULL,
  ADD COLUMN IF NOT EXISTS "frequency_hint" text,
  ADD COLUMN IF NOT EXISTS "cooking_difficulty" text,
  ADD COLUMN IF NOT EXISTS "availability" text,
  ADD COLUMN IF NOT EXISTS "special_handling_tags" jsonb DEFAULT '[]'::jsonb NOT NULL;

UPDATE "compass_health"."food_items"
SET "weight_type" = CASE
  WHEN "slug" IN ('oats', 'brown_rice', 'glass_noodles', 'nori_dried', 'dried_shrimp',
                  'red_bean', 'mung_bean', 'black_bean')
    OR "slug" LIKE '%_dried'
    OR "category" IN ('starch', 'nut')
    OR ("category" = 'legume' AND "slug" NOT IN ('tofu', 'soy_milk', 'soybean', 'edamame'))
    THEN 'dry'
  WHEN "slug" IN ('steamed_bun', 'quinoa_ciabatta') OR "category" = 'bread'
    THEN 'cooked'
  ELSE 'raw'
END
WHERE "weight_type" = 'raw';

UPDATE "compass_health"."food_items"
SET "allergen_tags" = CASE
  WHEN "slug" IN ('shrimp_jiweixia', 'dried_shrimp', 'shrimp_paste')
    THEN '["seafood", "shellfish", "shrimp"]'::jsonb
  WHEN "slug" IN ('salmon', 'cod', 'mackerel', 'sardine', 'hairtail', 'sea_bream')
    THEN '["seafood", "fish"]'::jsonb
  WHEN "category" = 'seafood'
    THEN '["seafood"]'::jsonb
  WHEN "slug" IN ('tofu', 'soy_milk', 'soybean', 'edamame') OR "slug" LIKE '%soy%'
    THEN '["soy"]'::jsonb
  WHEN "category" = 'dairy'
    THEN '["dairy"]'::jsonb
  WHEN "category" = 'nut'
    THEN '["nuts"]'::jsonb
  ELSE "allergen_tags"
END
WHERE "allergen_tags" = '[]'::jsonb;

UPDATE "compass_health"."food_items"
SET "special_handling_tags" = CASE
  WHEN "slug" = 'konjac'
    THEN '["filler", "not_vegetable"]'::jsonb
  WHEN "slug" = 'dried_shrimp'
    THEN '["seasoning", "high_sodium", "seasoning_not_main_protein"]'::jsonb
  WHEN "slug" = 'chicken_liver'
    THEN '["weekly_frequency"]'::jsonb
  ELSE "special_handling_tags"
END
WHERE "special_handling_tags" = '[]'::jsonb;

UPDATE "compass_health"."food_items"
SET "frequency_hint" = 'weekly'
WHERE "slug" = 'chicken_liver' AND "frequency_hint" IS NULL;
