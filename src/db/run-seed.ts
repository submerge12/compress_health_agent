import { resolve } from "node:path";

import { db, closeDb } from "./connection.js";
import { seedReferenceDataFromFiles, readCsvFile, loadFoodItemsFromCsv } from "./seed.js";
import { foodItems } from "./schema.js";

const SEED_DIR = resolve(import.meta.dirname, "../../seed");

async function main() {
  console.log("Seeding reference data (ingredients, seasonings, natural units)...");
  const counts = await seedReferenceDataFromFiles(db, {
    foodItemsPath: resolve(SEED_DIR, "ingredients.csv"),
    seasoningsPath: resolve(SEED_DIR, "seasonings.csv"),
    naturalUnitsPath: resolve(SEED_DIR, "natural_units.csv"),
  });
  console.log(`  Food items: ${counts.foodItems}`);
  console.log(`  Seasonings: ${counts.seasonings}`);
  console.log(`  Natural units: ${counts.naturalUnits}`);

  console.log("\nLoading integrated food library...");
  const libraryCsv = await readCsvFile(resolve(SEED_DIR, "food_library.csv"));
  const libraryRows = loadFoodItemsFromCsv(libraryCsv);
  if (libraryRows.length > 0) {
    const BATCH = 500;
    let inserted = 0;
    for (let i = 0; i < libraryRows.length; i += BATCH) {
      const batch = libraryRows.slice(i, i + BATCH);
      await db.insert(foodItems).values(batch).onConflictDoNothing();
      inserted += batch.length;
      if (inserted % 1000 === 0 || inserted === libraryRows.length) {
        console.log(`  ${inserted} / ${libraryRows.length}`);
      }
    }
  }
  console.log(`  Food library: ${libraryRows.length} foods loaded`);

  console.log("\nDone.");
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
