/**
 * M08 / P5 media pipeline invariants.
 *
 * Uses tiny synthetic video files (no real MP4 needed) with pre-probed
 * durations, plus real SRT content, so the full import → pair → index →
 * retrieve path runs on live PostgreSQL without large fixtures:
 * - SRT parser handles CRLF, BOM, and multi-line cues
 * - truncated SRT marks the pairing subtitle_truncated with usable window;
 *   segments beyond the window are neither created nor retrievable
 * - missing SRT marks missing_subtitle
 * - re-import is idempotent (no duplicate assets/pairings)
 * - search returns completeness metadata; feedback updates counters
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as schema from "../../src/db/schema.js";
import { createMediaImporter, parseSrt } from "../../src/media/importer.js";
import { createMediaIndexer, createMediaRetrieval } from "../../src/media/retrieval.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";

const isDbAvailable = await postgres(DATABASE_URL, { max: 1, connect_timeout: 3 })
  .unsafe("SELECT 1")
  .then(() => true)
  .catch(() => false);

function srt(cues: Array<[string, string, string]>): string {
  return cues.map(([i, a, b], idx) =>
    `${i}\n${a} --> ${b}\nCUE ${idx}: 卧推时肩胛骨收紧，肘部约 45 度。\n`,
  ).join("\n");
}

describe.skipIf(!isDbAvailable)("media pipeline invariants", () => {
  const pool = postgres(DATABASE_URL, { max: 4, prepare: false });
  const db = drizzle(pool, { schema });
  let dir: string;
  let feedbackUserId: string;
  const videoDurationMs = 10 * 60_000; // 10 minutes
  const cleanDecode = {
    fullDecodeStatus: "ok" as const,
    decodeErrorAtMs: null,
    usableVideoUntilMs: videoDurationMs,
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "media-test-"));
    const [user] = await db.insert(schema.users).values({ externalId: "media-test-user" }).returning();
    feedbackUserId = user!.id;
    // Minimal non-empty files as checksum stand-ins for videos.
    await writeFile(path.join(dir, "video-truncated.mp4"), Buffer.alloc(1024, 1));
    await writeFile(path.join(dir, "video-nosub.mp4"), Buffer.alloc(1024, 2));
    await writeFile(path.join(dir, "video-complete.mp4"), Buffer.alloc(1024, 3));
    await writeFile(path.join(dir, "video-corrupt-tail.mp4"), Buffer.alloc(1024, 4));
    await writeFile(path.join(dir, "sub-full.srt"), srt([
      ["1", "00:00:01,000", "00:00:04,000"],
      ["2", "00:09:30,000", "00:09:50,000"], // ends near video end → complete
    ]));
    await writeFile(path.join(dir, "sub-short.srt"), srt([
      ["1", "00:00:01,000", "00:00:04,000"],
      ["2", "00:04:00,000", "00:04:20,000"], // ends at 4:20 of a 10min video → truncated
    ]));
    await writeFile(path.join(dir, "sub-corrupt-tail.srt"), srt([
      ["1", "00:00:01,000", "00:00:04,000"],
      ["2", "00:09:30,000", "00:09:50,000"],
    ]));
  });

  afterAll(async () => {
    const assets = await db.select().from(schema.mediaAssets);
    for (const asset of assets.filter((a) => a.localPath.startsWith(dir))) {
      await db.delete(schema.mediaPairings).where(eq(schema.mediaPairings.videoAssetId, asset.id)).catch(() => undefined);
      await db.delete(schema.mediaAssets).where(eq(schema.mediaAssets.id, asset.id));
    }
    await db.delete(schema.users).where(eq(schema.users.externalId, "media-test-user"));
    await rm(dir, { recursive: true, force: true });
    await pool.end({ timeout: 3 });
  });

  it("SRT parser handles multi-line cues and both time separators", () => {
    const content = "\uFEFF1\r\n00:00:01,000 --> 00:00:03,500\r\n行一\r\n行二\r\n\r\n2\r\n00:00:05.000 --> 00:00:07.250\r\n下一条\r\n";
    const cues = parseSrt(content);
    expect(cues).toHaveLength(2);
    expect(cues[0]?.text).toContain("行二");
    expect(cues[1]?.startMs).toBe(5000);
  });

  it("truncated SRT yields subtitle_truncated with usable window; segments respect it", async () => {
    const importer = createMediaImporter(db);
    const { pairingId, completeness } = await importer.importEntry({
      trainer: "tanchengyi",
      sourceRole: "technique_details",
      title: "截断测试",
      localPath: path.join(dir, "video-truncated.mp4"),
      srtPath: path.join(dir, "sub-short.srt"),
    }, { videoDurationMs, decodeValidation: cleanDecode });

    expect(completeness).toBe("subtitle_truncated");
    const [pairing] = await db.select().from(schema.mediaPairings)
      .where(eq(schema.mediaPairings.id, pairingId));
    expect(pairing?.usableUntilMs).toBe(260_000); // 4m20s

    // Indexing must NOT produce segments beyond the usable window even if a
    // cue list contains them (indexer filters by usableUntil).
    const indexer = createMediaIndexer(db);
    await indexer.indexPairing(pairingId, [
      { index: 1, startMs: 0, endMs: 60_000, text: "前段" },
      { index: 2, startMs: 300_000, endMs: 360_000, text: "字幕覆盖外的尾部" },
    ]);
    const segments = await db.select().from(schema.videoSegments)
      .where(eq(schema.videoSegments.pairingId, pairingId));
    expect(segments.map((s) => s.startMs)).toEqual([0]); // tail excluded
  });

  it("missing SRT yields missing_subtitle", async () => {
    const importer = createMediaImporter(db);
    const { completeness } = await importer.importEntry({
      trainer: "curun",
      sourceRole: "chest_specialist",
      title: "无字幕测试",
      localPath: path.join(dir, "video-nosub.mp4"),
    }, { videoDurationMs, decodeValidation: cleanDecode });
    expect(completeness).toBe("missing_subtitle");
  });

  it("caps the pairing and indexed segments at the first full-decode error", async () => {
    const importer = createMediaImporter(db);
    const options = {
      videoDurationMs,
      decodeValidation: {
        fullDecodeStatus: "decode_errors" as const,
        decodeErrorAtMs: 180_000,
        usableVideoUntilMs: 180_000,
      },
    };
    const { pairingId, completeness } = await importer.importEntry({
      trainer: "curun",
      sourceRole: "chest_specialist",
      title: "损坏尾段测试",
      localPath: path.join(dir, "video-corrupt-tail.mp4"),
      srtPath: path.join(dir, "sub-corrupt-tail.srt"),
    }, options);
    expect(completeness).toBe("video_decode_error");
    const [pairing] = await db.select().from(schema.mediaPairings)
      .where(eq(schema.mediaPairings.id, pairingId));
    expect(pairing?.usableUntilMs).toBe(180_000);

    await createMediaIndexer(db).indexPairing(pairingId, [
      { index: 1, startMs: 60_000, endMs: 120_000, text: "完整可解码前段" },
      { index: 2, startMs: 200_000, endMs: 240_000, text: "解码错误后的损坏尾段" },
    ]);
    const segments = await db.select().from(schema.videoSegments)
      .where(eq(schema.videoSegments.pairingId, pairingId));
    expect(segments.map((segment) => segment.startMs)).toEqual([60_000]);
  });

  it("re-import is idempotent and search exposes completeness + role rules", async () => {
    const importer = createMediaImporter(db);
    const entry = {
      trainer: "kaishengwang" as const,
      sourceRole: "main_program" as const,
      title: "完整测试",
      localPath: path.join(dir, "video-complete.mp4"),
      srtPath: path.join(dir, "sub-full.srt"),
    };
    const first = await importer.importEntry(entry, { videoDurationMs, decodeValidation: cleanDecode });
    const second = await importer.importEntry(entry, { videoDurationMs, decodeValidation: cleanDecode });
    expect(second.pairingId).toBe(first.pairingId);

    const assets = await db.select().from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.localPath, entry.localPath));
    expect(assets).toHaveLength(1);

    expect(second.completeness).toBe("complete");

    const indexer = createMediaIndexer(db);
    await indexer.indexPairing(first.pairingId, [
      { index: 1, startMs: 60_000, endMs: 120_000, text: "卧推 肩胛 收紧" },
    ]);
    await indexer.confirmSegment((await db.select().from(schema.videoSegments)
      .where(eq(schema.videoSegments.pairingId, first.pairingId)))[0]!.id, {
      movementPattern: "horizontal_push",
      bodyPart: "chest",
    });

    const retrieval = createMediaRetrieval(db);
    const results = await retrieval.search({ movementPattern: "horizontal_push", limit: 5 });
    const hit = results.find((r) => r.title.includes("完整测试"));
    expect(hit).toBeDefined();
    expect(hit?.completeness).toBe("complete");
    expect(hit?.sourceRole).toBe("main_program");

    // Feedback updates counters.
    if (hit !== undefined) {
      await retrieval.recordFeedback(feedbackUserId!, hit.segmentId, true, "有用");
      const [after] = await db.select().from(schema.videoSegments)
        .where(eq(schema.videoSegments.id, hit.segmentId));
      expect(after?.helpfulCount).toBeGreaterThan(0);
    }
  });
});
