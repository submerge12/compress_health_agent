-- P0-2: repair migration — declare the user_id foreign keys that legacy
-- health tables (0005) never had. Historical migrations 0000-0013 are frozen;
-- all repairs land in files >= 0014 only.
--
-- Orphan policy: rows whose user_id has no matching compass_health.users row
-- are NOT deleted here. They are reported to the migration output so a human
-- can decide; adding the FK would fail while orphans exist, so those tables
-- keep working un-constrained and the orphan count is surfaced at every run.

CREATE SCHEMA IF NOT EXISTS compass_health;

DO $$
DECLARE
    tbl text;
    orphan_count bigint := 0;
    total_orphans bigint := 0;
BEGIN
    -- Tables from 0005 whose user_id never referenced users(id).
    FOREACH tbl IN ARRAY ARRAY[
        'bmr_profiles',
        'daily_activity_plans',
        'diet_logs',
        'exercise_logs',
        'meal_plan_entries',
        'physical_conditions',
        'water_logs'
    ]
    LOOP
        EXECUTE format(
            'SELECT count(*) FROM compass_health.%I t '
            || 'LEFT JOIN compass_health.users u ON u.id = t.user_id '
            || 'WHERE u.id IS NULL',
            tbl)
        INTO orphan_count;

        IF orphan_count > 0 THEN
            total_orphans := total_orphans + orphan_count;
            RAISE NOTICE 'migration 0014: table % has % orphan row(s) without a users match — FK NOT added, report for manual repair', tbl, orphan_count;
        ELSE
            -- The FK may already exist (e.g. a database that was repaired by
            -- hand before this migration shipped); add only when absent.
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = tbl || '_user_id_users_id_fk'
                  AND conrelid = format('compass_health.%I', tbl)::regclass
            ) THEN
                EXECUTE format(
                    'ALTER TABLE compass_health.%I '
                    || 'ADD CONSTRAINT %I FOREIGN KEY (user_id) '
                    || 'REFERENCES compass_health.users(id) ON DELETE CASCADE',
                    tbl, tbl || '_user_id_users_id_fk');
                RAISE NOTICE 'migration 0014: FK added on %', tbl;
            ELSE
                RAISE NOTICE 'migration 0014: FK already present on %', tbl;
            END IF;
        END IF;
    END LOOP;

    IF total_orphans > 0 THEN
        RAISE WARNING 'migration 0014: % orphan row(s) across legacy tables — see notices above', total_orphans;
    END IF;
END $$;

-- The FK-less state of an orphaned table is re-checked by assertSchemaReady's
-- critical-object list only loosely (tables exist); the orphan report above is
-- the authoritative signal until a human resolves the rows.
