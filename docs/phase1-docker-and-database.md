# Phase 1: Docker & Database Setup

This document records every step from bare machine to a running PostgreSQL database with seeded data, as executed on 2026-06-17.

---

## 1. Pre-existing Docker Environment

The host machine (Windows 11) already had Docker Desktop installed. Before this project, three Docker Compose stacks were running:

| Container | Image | Host Port | Purpose |
|---|---|---|---|
| `docker-db-1` | postgres:15-alpine | **5432** | Dify (LLM platform) |
| `multica-postgres-1` | pgvector/pgvector:pg17 | internal | Multica |
| `docker-nginx-1` | nginx:latest | 80, 443 | Reverse proxy |
| + 8 others | various | various | Dify workers, Redis, Weaviate, etc. |

Port 5432 was already occupied, so this project uses **port 5433**.

---

## 2. Docker Compose Configuration

**File:** `docker-compose.yml`

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    container_name: compass-health-pg
    ports:
      - "5433:5432"
    environment:
      POSTGRES_USER: compass
      POSTGRES_PASSWORD: compass
      POSTGRES_DB: compass_health
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U compass -d compass_health"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
```

**Key decisions:**
- **pgvector/pgvector:pg17** — PostgreSQL 17 with vector extension built in, for future food similarity search
- **Port 5433** — avoids conflict with Dify's PostgreSQL on 5432
- **Named volume `pgdata`** — data persists across container restarts
- **Healthcheck** — `pg_isready` every 5s so dependent services can wait

---

## 3. Startup Sequence

```
$ docker compose up -d

 Network compass-health-agent_default  Created
 Volume "compass-health-agent_pgdata"  Created
 Container compass-health-pg           Created → Started
```

**Docker resources created:**

| Resource | Type | Name |
|---|---|---|
| Network | bridge | `compass-health-agent_default` |
| Volume | local | `compass-health-agent_pgdata` |
| Container | — | `compass-health-pg` |

Verified readiness:
```
$ docker exec compass-health-pg pg_isready -U compass -d compass_health
/var/run/postgresql:5432 - accepting connections
```

(Inside the container it listens on 5432; the host maps this to 5433.)

---

## 4. Schema Push (Drizzle ORM)

The application connects using:
```
DATABASE_URL=postgres://compass:compass@localhost:5433/compass_health
```

Schema is defined in `src/db/schema.ts` using Drizzle ORM and pushed with:
```
$ npx drizzle-kit push
```

This created **14 tables** in the `public` schema:

| Table | Purpose | Key Columns |
|---|---|---|
| `users` | Multi-user support | `external_id`, `locale`, `timezone` |
| `bmr_profiles` | BMR/TDEE/target calculations | `sex`, `age_years`, `height_cm`, `weight_kg`, `goal`, `target_kcal` |
| `daily_activity_plans` | Per-day calorie budgets | `plan_date`, `breakfast_kcal`, `lunch_kcal`, `dinner_kcal` |
| `food_items` | Ingredient & food library | `slug` (unique), `name`, `name_zh`, 18 nutrition columns |
| `seasonings` | Cooking condiments | `slug` (unique), `sodium_mg_per_100g`, `serving_grams` |
| `natural_units` | Human-readable units (碗, 个, 片) | `food_slug` + `unit_name` (unique), `grams` |
| `diet_logs` | What the user actually ate | `meal_type`, `ingredients_json`, nutrition totals |
| `water_logs` | Hydration tracking | `amount_ml` |
| `exercise_logs` | Activity tracking | `activity_type`, `duration_minutes`, `calories_burned_kcal` |
| `physical_conditions` | Weight, body fat, waist, sleep | `weight_kg`, `body_fat_percent`, `sleep_hours` |
| `meal_plan_entries` | Planned meals | `dish_name`, `recipe_slug`, `status` |
| `cooking_records` | User's recipe history | `dish_name`, `ingredients_json`, `times_cooked`, `rating` |
| `meal_compositions` | Links meal plans/diet logs to individual components | `component_name`, `quantity_grams` |
| `user_seasoning_preferences` | Per-user seasoning limits | `preference`, `max_grams_per_meal`, `avoid` |

All tables share common columns: `id` (UUID v4), `created_at`, `updated_at`.

Nutrition columns (shared by `food_items`, `diet_logs`, `meal_plan_entries`, `cooking_records`, `meal_compositions`):
`calories_kcal`, `protein_grams`, `carbs_grams`, `fat_grams`, `fiber_grams`, `sugar_grams`, `sodium_mg`, `potassium_mg`, `calcium_mg`, `iron_mg`, `magnesium_mg`, `zinc_mg`, `vitamin_a_mcg`, `vitamin_c_mg`, `vitamin_d_mcg`, `vitamin_b12_mcg`, `folate_mcg`, `cholesterol_mg`

---

## 5. Data Seeding

**Script:** `src/db/run-seed.ts` (run via `pnpm db:seed`)

### 5.1 User Ingredients (32 items)

**Source:** `seed/ingredients.csv` (from `seed_my_ingredients.csv`)

Personal ingredient library with full nutrition per 100g edible portion. Sources: Chinese Food Composition Tables (xlsx/CFCT6), USDA Foundation, package labels.

Categories: grains (5), vegetables (6), mushroom/seaweed (3), protein (7), dairy (2), nuts (4), fruit (3), other (1).

### 5.2 Seasonings (20 items)

**Source:** `seed/seasonings.csv` (from `seed_my_seasonings.csv`)

Each seasoning has per-100g nutrition, typical serving size, and sodium density. Critical for sodium tracking — e.g., light soy sauce at 5,757 mg/100g.

Categories: oil (2), sauce (4), vinegar (1), salt (1), spice (7), aromatic (5).

### 5.3 Natural Units (35 mappings)

**Source:** `seed/natural_units.csv` (from `seed_my_natural_units.csv`)

Maps human-readable units to grams: 1碗糙米饭 = 150g (cooked), 1个鸡蛋 = 50g, 1朵西兰花 = 15g. Some ingredients have multiple units (broccoli: floret 15g / bunch 200g).

### 5.4 Integrated Food Library (2,302 → 1,521 unique)

**Source:** `seed/food_library.csv` (from `integrated_food_nutrition.csv`)

Merged from: xlsx primary (1,752 foods), CFCT6 for sodium gaps, Juhe for fiber/fatty acids, USDA for international items. After deduplication by slug, 1,521 unique foods loaded.

### Seed Sequence

```
$ pnpm db:seed

Seeding reference data (ingredients, seasonings, natural units)...
  Food items: 32        ← user's personal ingredients (inserted first, take priority)
  Seasonings: 20
  Natural units: 35

Loading integrated food library...
  1000 / 2302
  2000 / 2302
  2302 / 2302           ← duplicates skipped via ON CONFLICT DO NOTHING on slug
  Food library: 2302 foods loaded
```

The seed is **idempotent** — running it multiple times produces no duplicates. User ingredients are inserted first so they take priority over food library entries with the same slug.

---

## 6. Issues Found & Fixed

### 6.1 Quinoa Ciabatta Sodium Misalignment

The value `428.0` (sodium from package label) was placed in column 24 (`potassium_mg`) instead of column 25 (`sodium_mg`) in the source CSV. Off-by-one: one comma was missing between the empty `phosphorus_mg` and the sodium value.

**Fixed in both:**
- `G:\compass-health-agent\seed\ingredients.csv`
- `C:\Users\Holly\compass-health\seed_my_ingredients.csv`

### 6.2 Natural Units Missing Unique Constraint

The `natural_units` table had no unique constraint on `(food_slug, unit_name)`. Running the seed script twice created 70 duplicate rows. 

**Fixed:** Added `unique().on(t.foodSlug, t.unitName)` to the Drizzle schema and applied via SQL:
```sql
ALTER TABLE natural_units
  ADD CONSTRAINT natural_units_food_slug_unit_name_unique
  UNIQUE (food_slug, unit_name);
```

### 6.3 Seed CSV Column Mapping Mismatches

The seed parser's column aliases didn't match the actual CSV headers. Fixed mappings:

| Parser Field | Before (wrong) | After (correct) |
|---|---|---|
| Food name | `name`, `food_name` | `name_en`, `name`, `food_name` |
| Food category | `category`, `group` | `category_en`, `category`, `group` |
| Fiber | `fiber_grams`, `fiber_g` | `dietary_fiber_g`, `fiber_grams`, `fiber_g` |
| Vitamin A | `vitamin_a_mcg`, `vitamin_a` | `vitamin_a_ug_re`, `vitamin_a_mcg`, `vitamin_a` |
| Seasoning name | `name` | `name_en`, `name` |
| Serving grams | `serving_grams` | `typical_serving_g`, `serving_grams` |
| Serving unit | `serving_unit` | `typical_serving_unit_en`, `serving_unit` |
| Sodium per 100g | `sodium_mg_per_100g` | `sodium_mg`, `sodium_mg_per_100g` |
| Seasoning kcal | `calories_kcal_per_100g` | `energy_kcal`, `calories_kcal_per_100g` |
| Natural unit slug | `food_slug`, `slug` | `ingredient_slug`, `food_slug`, `slug` |
| Unit name | `unit_name`, `unit` | `unit_en`, `unit_name`, `unit` |
| Unit grams | `grams`, `gram_weight` | `grams_per_unit`, `grams`, `gram_weight` |

---

## 7. Current State

```
Container:  compass-health-pg (healthy, port 5433)
Image:      pgvector/pgvector:pg17
Database:   compass_health (8.8 MB)
Owner:      compass
Tables:     14
```

| Table | Rows | Status |
|---|---|---|
| food_items | 1,521 | Seeded (32 personal + 1,489 from library) |
| seasonings | 20 | Seeded |
| natural_units | 35 | Seeded |
| users | 0 | Empty (created at runtime) |
| bmr_profiles | 0 | Empty |
| diet_logs | 0 | Empty |
| water_logs | 0 | Empty |
| exercise_logs | 0 | Empty |
| meal_plan_entries | 0 | Empty |
| cooking_records | 0 | Empty |
| meal_compositions | 0 | Empty |
| physical_conditions | 0 | Empty |
| daily_activity_plans | 0 | Empty |
| user_seasoning_preferences | 0 | Empty |

---

## 8. Common Operations

```bash
# Start PostgreSQL
docker compose up -d

# Stop PostgreSQL (data persists)
docker compose down

# Stop and delete all data
docker compose down -v

# Push schema changes
pnpm db:push

# Seed / re-seed (idempotent)
pnpm db:seed

# Connect to psql
docker exec -it compass-health-pg psql -U compass -d compass_health

# Check container health
docker compose ps
```
