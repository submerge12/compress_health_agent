import { resolve } from "node:path";

import { eq, sql } from "drizzle-orm";

import { db, closeDb } from "./connection.js";
import {
  dedupeFoodLibraryRows,
  dedupeRowsBySlug,
  insertFoodAliases,
  loadFoodAliasesFromCsv,
  loadFoodItemsFromCsv,
  readCsvFile,
  seedReferenceDataFromFiles,
} from "./seed.js";
import type { FoodItemSeed } from "./seed.js";
import { foodItems } from "./schema.js";

const SEED_DIR = resolve(import.meta.dirname, "../../seed");

async function main() {
  console.log("Seeding reference data (ingredients, seasonings, natural units)...");
  const ingredientsPath = resolve(SEED_DIR, "ingredients.csv");
  const counts = await seedReferenceDataFromFiles(db, {
    foodItemsPath: ingredientsPath,
    seasoningsPath: resolve(SEED_DIR, "seasonings.csv"),
    naturalUnitsPath: resolve(SEED_DIR, "natural_units.csv"),
  });
  console.log(`  Food items: ${counts.foodItems}`);
  console.log(`  Food aliases: ${counts.foodAliases}`);
  console.log(`  Seasonings: ${counts.seasonings}`);
  console.log(`  Natural units: ${counts.naturalUnits}`);

  console.log("\nLoading integrated food library...");
  const curatedCsv = await readCsvFile(ingredientsPath);
  const curatedRows = loadFoodItemsFromCsv(curatedCsv);
  const curatedAliases = loadFoodAliasesFromCsv(curatedCsv);
  const libraryCsv = await readCsvFile(resolve(SEED_DIR, "food_library.csv"));
  const libraryDedupe = dedupeFoodLibraryRows(curatedRows, curatedAliases, loadFoodItemsFromCsv(libraryCsv));
  // Batch upserts require slug-unique batches: the library CSV contains many
  // rows sharing one name (and therefore one slug), e.g. variants of the same
  // fish, which would make ON CONFLICT DO UPDATE hit a row twice.
  const libraryRows = dedupeRowsBySlug(libraryDedupe.foodItems);
  const intraBatchDuplicates = libraryDedupe.foodItems.length - libraryRows.length;
  await insertFoodAliases(db, libraryDedupe.aliases);
  if (libraryRows.length > 0) {
    const BATCH = 500;
    let inserted = 0;
    for (let i = 0; i < libraryRows.length; i += BATCH) {
      const batch = libraryRows.slice(i, i + BATCH);
      await db.insert(foodItems).values(batch).onConflictDoUpdate({
        target: foodItems.slug,
        set: {
          allergenTags: sql.raw("excluded.allergen_tags"),
        },
      });
      inserted += batch.length;
      if (inserted % 1000 === 0 || inserted === libraryRows.length) {
        console.log(`  ${inserted} / ${libraryRows.length}`);
      }
    }
  }
  const refreshedDuplicateAllergens = await refreshSkippedDuplicateAllergenTags(libraryDedupe.skippedFoodItems);
  console.log(`  Food library: ${libraryRows.length} foods loaded`);
  console.log(`  Food library intra-batch duplicate slugs merged: ${intraBatchDuplicates}`);
  console.log(`  Food library duplicates skipped: ${libraryDedupe.skippedCount}`);
  console.log(`  Food library duplicate allergen refreshes: ${refreshedDuplicateAllergens}`);
  console.log(`  Food aliases from duplicates: ${libraryDedupe.aliases.length}`);

  console.log("\nDone.");
  await closeDb();
}

async function refreshSkippedDuplicateAllergenTags(rows: readonly FoodItemSeed[]): Promise<number> {
  let refreshed = 0;
  for (const row of rows) {
    if (row.allergenTags.length === 0) {
      continue;
    }

    const updatedRows = await db.update(foodItems)
      .set({
        allergenTags: row.allergenTags,
        updatedAt: sql`now()`,
      })
      .where(eq(foodItems.slug, row.slug))
      .returning({ slug: foodItems.slug });
    refreshed += updatedRows.length;
  }
  return refreshed;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
