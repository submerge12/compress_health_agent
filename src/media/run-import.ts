/**
 * M08 / P5: one-shot bulk import of the user's 12 training assets.
 * Run: DATABASE_URL=... npx tsx src/media/run-import.ts
 * Idempotent — safe to re-run; re-imports refresh metadata in place.
 */
import "dotenv/config";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../db/schema.js";
import { createMediaImporter, defaultManifest } from "./importer.js";
import { createMediaIndexer } from "./retrieval.js";
import { readFile } from "node:fs/promises";

const url = process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";
const pool = postgres(url, { max: 2, prepare: false });
const db = drizzle(pool, { schema });

const DOWNLOADS = String(process.env["MEDIA_DOWNLOADS_DIR"] ?? "C:\\Users\\Holly\\Downloads");
const DOUYIN = String(process.env["MEDIA_VIDEO_DIR"] ?? "C:\\Users\\Holly\\Downloads\\douyin");

// Body-part hints per entry title for the draft index.
const BODY_PARTS: Record<string, string> = {
  "三分化①训练计划": "program",
  "三分化②跟练胸肩三头": "chest",
  "三分化④跟练背肩后束二头": "back",
  "三分化⑤跟练腿": "legs",
  "卧推找不到胸发力私教课": "chest",
  "手臂教学第二期（SRT 截断）": "arms",
  "手臂训练二": "arms",
  "肩部教学": "shoulders",
  "胸部教学（SRT 截断）": "chest",
  "腹肌教学": "core",
  "腿部训练": "legs",
  "背部跟练": "back",
};

async function main() {
  const importer = createMediaImporter(db);
  const indexer = createMediaIndexer(db);
  const manifest = defaultManifest(DOWNLOADS, DOUYIN);

  let ok = 0;
  for (const entry of manifest) {
    try {
      const { pairingId, completeness } = await importer.importEntry(entry);
      // Index draft segments from the paired SRT.
      if (entry.srtPath) {
        try {
          const content = await readFile(entry.srtPath, "utf8");
          const { parseSrt } = await import("./importer.js");
          await indexer.indexPairing(pairingId, parseSrt(content), {
            bodyPart: BODY_PARTS[entry.title],
          });
        } catch (indexError) {
          console.warn(`[warn] ${entry.title}: imported (${completeness}) but indexing failed:`, indexError instanceof Error ? indexError.message : indexError);
        }
      }
      console.log(`[ok] ${entry.title}: ${completeness}`);
      ok += 1;
    } catch (error) {
      console.error(`[fail] ${entry.title}:`, error instanceof Error ? error.message : error);
    }
  }
  console.log(`\n${ok}/${manifest.length} entries imported.`);
  await pool.end({ timeout: 5 });
}

void main();
