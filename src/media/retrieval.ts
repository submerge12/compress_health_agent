/**
 * M08 / P5: segment indexing and retrieval.
 *
 * Indexer: chunk subtitle cues into topical windows (sliding merge on silence
 * and length) as DRAFT segments — human confirmation refines titles/tags
 * later; drafts are retrievable but marked draft.
 *
 * Retrieval (plan §13.5): deterministic filters first (completeness window,
 * pattern/body part/category), then trainer source-role rules:
 *   main_program may structure the plan;
 *   chest_specialist / technique_details may explain and correct but NEVER
 *   add sets to the main program (enforced here, not by prompt).
 */
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";
import type { SrtCue } from "./importer.js";

type Db = PostgresJsDatabase<typeof schema>;

const MAX_WINDOW_MS = 8 * 60 * 1000;
const MIN_GAP_MS = 4_000;

export function createMediaIndexer(db: Db) {
  /** Chunk cues into draft segments for a pairing. Idempotent per pairing. */
  async function indexPairing(pairingId: string, cues: SrtCue[], options?: {
    bodyPart?: string;
    movementPattern?: string;
  }): Promise<{ created: number }> {
    await db.delete(schema.videoSegments).where(and(
      eq(schema.videoSegments.pairingId, pairingId),
      eq(schema.videoSegments.reviewStatus, "draft"),
      // confirmed segments survive re-indexing; drafts are rebuilt
      isNull(schema.videoSegments.supersededById),
    ));

    if (cues.length === 0) return { created: 0 };

    const [pairing] = await db.select().from(schema.mediaPairings)
      .where(eq(schema.mediaPairings.id, pairingId))
      .limit(1);
    if (!pairing) throw new RangeError("pairing not found");
    const [video] = await db.select().from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.id, pairing.videoAssetId))
      .limit(1);
    if (!video) throw new RangeError("video asset not found");

    const usableUntil = effectiveUsableUntil(pairing, video);
    if (
      usableUntil === null
      || video.probeStatus !== "ok"
      || !["ok", "decode_errors"].includes(video.fullDecodeStatus)
    ) {
      return { created: 0 };
    }

    const windows: Array<{ startMs: number; endMs: number; texts: string[] }> = [];
    let current: { startMs: number; endMs: number; texts: string[] } | null = null;
    for (const cue of cues) {
      if (cue.startMs >= usableUntil) break; // truncated tail produces no evidence
      if (cue.endMs > usableUntil) continue;
      if (
        current !== null &&
        (cue.endMs - current.startMs > MAX_WINDOW_MS ||
          (cue.startMs - current.endMs > MIN_GAP_MS && current.endMs - current.startMs > 60_000))
      ) {
        windows.push(current);
        current = null;
      }
      if (current === null) {
        current = { startMs: cue.startMs, endMs: cue.endMs, texts: [] };
      }
      current.endMs = cue.endMs;
      current.texts.push(cue.text);
    }
    if (current !== null && current.endMs > current.startMs) {
      windows.push(current);
    }

    if (windows.length === 0) return { created: 0 };

    await db.insert(schema.videoSegments).values(windows.map((w) => ({
      pairingId,
      startMs: w.startMs,
      endMs: w.endMs,
      trainer: video.trainer,
      // P0-7: the manifest-declared role stored on the asset wins; no
      // trainer-name inference at index time.
      sourceRole: (video.sourceRole as "main_program" | "chest_specialist" | "technique_details"),
      title: `${video.title} · ${formatTs(w.startMs)}-${formatTs(w.endMs)}`,
      bodyPart: options?.bodyPart ?? null,
      movementPattern: options?.movementPattern ?? null,
      category: categoryFor(video.trainer),
      cuesText: w.texts.join("\n").slice(0, 8000),
      reviewStatus: "draft",
    })));

    const counts = await db.select({ n: sql<number>`count(*)::int` })
      .from(schema.videoSegments)
      .where(eq(schema.videoSegments.pairingId, pairingId));
    return { created: counts[0]?.n ?? 0 };
  }

  async function confirmSegment(segmentId: string, patch?: {
    title?: string;
    bodyPart?: string;
    movementPattern?: string;
    exerciseSlug?: string;
    category?: string;
  }): Promise<void> {
    await db.update(schema.videoSegments).set({
      reviewStatus: "confirmed",
      ...(patch?.title !== undefined ? { title: patch.title } : {}),
      ...(patch?.bodyPart !== undefined ? { bodyPart: patch.bodyPart } : {}),
      ...(patch?.movementPattern !== undefined ? { movementPattern: patch.movementPattern } : {}),
      ...(patch?.exerciseSlug !== undefined ? { exerciseSlug: patch.exerciseSlug } : {}),
      ...(patch?.category !== undefined ? { category: patch.category } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.videoSegments.id, segmentId));
  }

  return { indexPairing, confirmSegment };
}

function formatTs(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function categoryFor(trainer: string): string {
  return trainer === "curun" ? "correction" : "practice";
}

export interface SearchQuery {
  movementPattern?: string;
  bodyPart?: string;
  category?: string;
  text?: string;
  limit?: number;
}

function minimumPositive(...values: Array<number | null | undefined>): number | null {
  const candidates = values.filter(
    (value): value is number => value !== null && value !== undefined && Number.isFinite(value) && value > 0,
  );
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

function effectiveUsableUntil(
  pairing: typeof schema.mediaPairings.$inferSelect,
  asset: typeof schema.mediaAssets.$inferSelect,
): number | null {
  if (pairing.usableUntilMs === null || pairing.subtitleEndMs === null) return null;
  const assetLimit = asset.fullDecodeStatus === "ok"
    ? (asset.usableVideoUntilMs ?? asset.durationMs)
    : asset.fullDecodeStatus === "decode_errors"
      ? minimumPositive(asset.usableVideoUntilMs, asset.decodeErrorAtMs)
      : null;
  if (assetLimit === null) return null;
  return minimumPositive(pairing.usableUntilMs, pairing.subtitleEndMs, assetLimit);
}

export function createMediaRetrieval(db: Db) {
  /**
   * P0-7: ONE SQL statement — filters, text matching, ordering and limit all
   * happen in the database. The previous two-step (fetch N, then filter by
   * separately-matched IDs) silently dropped any match ranked beyond the
   * initial fetch.
   */
  async function search(query: SearchQuery): Promise<Array<{
    segmentId: string;
    title: string;
    trainer: string;
    sourceRole: string;
    category: string;
    startMs: number;
    endMs: number;
    /** Authenticated stream URL path; localPath is NEVER exposed (P0-7). */
    streamUrl: string;
    completeness: string;
    usableUntilMs: number | null;
    snippet: string;
    reviewStatus: string;
    helpfulCount: number;
    notHelpfulCount: number;
    fullDecodeStatus: string;
    decodeErrorAtMs: number | null;
  }>> {
    const assetSafetyLimit = sql<number>`CASE
      WHEN ${schema.mediaAssets.fullDecodeStatus} = 'ok'
        THEN COALESCE(${schema.mediaAssets.usableVideoUntilMs}, ${schema.mediaAssets.durationMs})
      WHEN ${schema.mediaAssets.fullDecodeStatus} = 'decode_errors'
        THEN LEAST(
          COALESCE(${schema.mediaAssets.usableVideoUntilMs}, ${schema.mediaAssets.decodeErrorAtMs}),
          COALESCE(${schema.mediaAssets.decodeErrorAtMs}, ${schema.mediaAssets.usableVideoUntilMs})
        )
      ELSE NULL
    END`;
    const effectiveLimit = sql<number>`CASE
      WHEN ${schema.mediaPairings.usableUntilMs} IS NULL
        OR ${schema.mediaPairings.subtitleEndMs} IS NULL
        OR ${assetSafetyLimit} IS NULL
        THEN NULL
      ELSE LEAST(
        ${schema.mediaPairings.usableUntilMs},
        ${schema.mediaPairings.subtitleEndMs},
        ${assetSafetyLimit}
      )
    END`;
    const conditions = [
      isNull(schema.videoSegments.supersededById),
      eq(schema.mediaAssets.probeStatus, "ok"),
      inArray(schema.mediaAssets.fullDecodeStatus, ["ok", "decode_errors"]),
      // Recompute the effective limit at read time so stale pairing metadata
      // cannot expose a segment beyond an asset or subtitle safety boundary.
      gte(effectiveLimit, schema.videoSegments.endMs),
    ];
    if (query.movementPattern) conditions.push(eq(schema.videoSegments.movementPattern, query.movementPattern));
    if (query.bodyPart) conditions.push(eq(schema.videoSegments.bodyPart, query.bodyPart));
    if (query.category) conditions.push(eq(schema.videoSegments.category, query.category));
    if (query.text !== undefined && query.text !== "") {
      const like = `%${query.text}%`;
      conditions.push(or(
        sql`${schema.videoSegments.cuesText} ILIKE ${like}`,
        sql`${schema.videoSegments.title} ILIKE ${like}`,
      )!);
    }

    const chestCorrection = query.category === "correction"
      || query.bodyPart === "chest"
      || query.movementPattern === "horizontal_push"
      || /(?:chest|bench|卧推|胸)/iu.test(query.text ?? "");
    const reviewRank = sql<number>`CASE ${schema.videoSegments.reviewStatus}
      WHEN 'confirmed' THEN 0
      WHEN 'draft' THEN 1
      ELSE 2
    END`;
    const contextualRoleBoost = chestCorrection
      ? sql<number>`CASE ${schema.videoSegments.sourceRole}
          WHEN 'chest_specialist' THEN 2
          ELSE 0
        END`
      : sql<number>`0`;
    const feedbackScore = sql<number>`
      ${schema.videoSegments.helpfulCount}
      - ${schema.videoSegments.notHelpfulCount}
      + ${contextualRoleBoost}`;

    const rows = await db.select({
      id: schema.videoSegments.id,
      title: schema.videoSegments.title,
      trainer: schema.videoSegments.trainer,
      sourceRole: schema.videoSegments.sourceRole,
      category: schema.videoSegments.category,
      startMs: schema.videoSegments.startMs,
      endMs: schema.videoSegments.endMs,
      cuesText: schema.videoSegments.cuesText,
      reviewStatus: schema.videoSegments.reviewStatus,
      helpfulCount: schema.videoSegments.helpfulCount,
      notHelpfulCount: schema.videoSegments.notHelpfulCount,
      completeness: schema.mediaPairings.completeness,
      usableUntilMs: effectiveLimit,
      decodeErrorAtMs: schema.mediaAssets.decodeErrorAtMs,
      fullDecodeStatus: schema.mediaAssets.fullDecodeStatus,
    })
      .from(schema.videoSegments)
      .innerJoin(schema.mediaPairings, eq(schema.videoSegments.pairingId, schema.mediaPairings.id))
      .innerJoin(schema.mediaAssets, eq(schema.mediaPairings.videoAssetId, schema.mediaAssets.id))
      .where(and(...conditions))
      // Explicit review ordering avoids relying on lexical status order.
      // Within a review tier, contextual role and feedback remain adaptive.
      .orderBy(
        asc(reviewRank),
        desc(feedbackScore),
        asc(schema.videoSegments.startMs),
        asc(schema.videoSegments.id),
      )
      .limit(query.limit ?? 10);

    return rows.map((r) => ({
      segmentId: r.id,
      title: r.title,
      trainer: r.trainer,
      sourceRole: r.sourceRole,
      category: r.category,
      startMs: r.startMs,
      endMs: r.endMs,
      streamUrl: `/api/v1/media/segments/${r.id}/stream`,
      completeness: r.completeness,
      usableUntilMs: r.usableUntilMs,
      snippet: r.cuesText.slice(0, 400),
      fullDecodeStatus: r.fullDecodeStatus,
      decodeErrorAtMs: r.decodeErrorAtMs,
      reviewStatus: r.reviewStatus,
      helpfulCount: r.helpfulCount,
      notHelpfulCount: r.notHelpfulCount,
    }));
  }

  async function recordFeedback(userId: string, segmentId: string, helpful: boolean, note?: string): Promise<{ feedbackId: string }> {
    const [feedback] = await db.insert(schema.segmentFeedback)
      .values({ userId, segmentId, helpful, note: note ?? null })
      .returning({ id: schema.segmentFeedback.id });
    if (!feedback) throw new Error("media feedback insert returned no row");
    await db.update(schema.videoSegments).set(
      helpful
        ? { helpfulCount: sql`${schema.videoSegments.helpfulCount} + 1`, updatedAt: new Date() }
        : { notHelpfulCount: sql`${schema.videoSegments.notHelpfulCount} + 1`, updatedAt: new Date() },
    ).where(eq(schema.videoSegments.id, segmentId));
    return { feedbackId: feedback.id };
  }

  return { search, recordFeedback };
}
