/**
 * M08 / P5: media import pipeline — manifest → checksum → probe → SRT parse
 * → pairing → completeness. Binaries never move; only metadata enters PG.
 *
 * Completeness rules (plan §13.1):
 * - subtitle ends well before video ends → subtitle_truncated; segments are
 *   usable only inside the covered window (usableUntilMs);
 * - no pairing → missing_subtitle for the video, and the SRT is an orphan;
 * - probe failure → decode_error / unreadable, asset is quarantined from
 *   retrieval regardless of any "complete" claim.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { validateFullDecode, type DecodeValidation } from "./decode-validator.js";

async function fileSizeBytes(filePath: string): Promise<number> {
  try {
    const stat = await import("node:fs/promises").then((fs) => fs.stat(filePath));
    return Number(stat.size);
  } catch {
    return 0;
  }
}

import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";

type Db = PostgresJsDatabase<typeof schema>;

export interface SrtCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export function parseSrt(content: string): SrtCue[] {
  const cues: SrtCue[] = [];
  const blockRe = /(\d+)\s*\n(\d{1,2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{3})\s*\n([\s\S]*?)(?=\n\s*\n|\n*$)/g;
  const toMs = (ts: string): number => {
    const m = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/.exec(ts);
    if (m === null || m[4] === undefined) throw new RangeError(`bad timestamp ${ts}`);
    return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
  };
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(content)) !== null) {
    const indexGroup = match[1];
    const startGroup = match[2];
    const endGroup = match[3];
    const textGroup = match[4];
    if (indexGroup === undefined || startGroup === undefined || endGroup === undefined || textGroup === undefined) {
      continue;
    }
    cues.push({
      index: Number(indexGroup),
      startMs: toMs(startGroup),
      endMs: toMs(endGroup),
      text: textGroup.replace(/\r/g, "").trim(),
    });
  }
  return cues;
}

export async function sha256File(filePath: string): Promise<string> {
  // WO-HS-09: stream the file - multi-GB videos must not be read into memory.
  const { createReadStream } = await import("node:fs");
  const stat = await import("node:fs/promises").then((fs) => fs.stat(filePath));
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
    void stat;
  });
}

/** ffprobe duration in ms; null when the tool or file is unusable. */
export async function probeDurationMs(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
      { timeout: 30_000 },
    );
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
  } catch {
    return null;
  }
}

const TRUNCATION_TOLERANCE_MS = 20_000;

export type TrainerKey = "kaishengwang" | "curun" | "tanchengyi";
export type SourceRole = "main_program" | "chest_specialist" | "technique_details";

export interface ManifestVideo {
  trainer: TrainerKey;
  sourceRole: SourceRole;
  title: string;
  localPath: string;
  /** Declared SRT path (manifest mapping wins over filename guessing). */
  srtPath?: string;
  notes?: string;
}

export function createMediaImporter(db: Db) {
  /**
   * Import one manifest entry: upsert both assets by content hash, pair them,
   * compute completeness, and store the pairing's usable window.
   * Idempotent: re-running updates metadata in place, never duplicates.
   */
  async function importEntry(entry: ManifestVideo, options?: {
    videoDurationMs?: number | null; // pre-probed (tests); skips ffprobe
    skipDecodeValidation?: boolean; // tests; skips the expensive full decode
    /** Deterministic full-decode result for tests and offline import orchestration. */
    decodeValidation?: DecodeValidation;
  }): Promise<{ pairingId: string; completeness: string }> {
    const videoSha = await sha256File(entry.localPath);
    const videoDuration = options?.videoDurationMs !== undefined
      ? options.videoDurationMs
      : await probeDurationMs(entry.localPath);
    // WO-HS-09: header probe is not enough; fully decode to find mid-file
    // corruption. Tests may skip this via options.skipDecodeValidation.
    const decode = options?.decodeValidation
      ?? (options?.skipDecodeValidation ? null : await validateFullDecode(entry.localPath));
    const storedDecode = decode ?? {
      fullDecodeStatus: "unprobed" as const,
      decodeErrorAtMs: null,
      usableVideoUntilMs: null,
    };

    const [videoAsset] = await db.insert(schema.mediaAssets).values({
      kind: "video",
      trainer: entry.trainer,
      // P0-7: sourceRole comes from the MANIFEST, never inferred from the
      // trainer name at query time.
      sourceRole: entry.sourceRole,
      title: entry.title,
      localPath: entry.localPath,
      sha256: videoSha,
      durationMs: videoDuration,
      probeStatus: videoDuration === null ? "unreadable" : "ok",
      contentType: "video/mp4",
      fullDecodeStatus: storedDecode.fullDecodeStatus,
      decodeErrorAtMs: storedDecode.decodeErrorAtMs,
      usableVideoUntilMs: storedDecode.usableVideoUntilMs,
      bytes: await fileSizeBytes(entry.localPath),
    }).onConflictDoUpdate({
      target: [schema.mediaAssets.sha256, schema.mediaAssets.kind],
      set: {
        title: entry.title,
        localPath: entry.localPath,
        sourceRole: entry.sourceRole,
        durationMs: videoDuration,
        probeStatus: videoDuration === null ? "unreadable" : "ok",
        fullDecodeStatus: storedDecode.fullDecodeStatus,
        decodeErrorAtMs: storedDecode.decodeErrorAtMs,
        usableVideoUntilMs: storedDecode.usableVideoUntilMs,
        updatedAt: new Date(),
      },
    }).returning();
    if (!videoAsset) throw new Error("video asset upsert returned no row");

    let subtitleId: string | null = null;
    let subtitleEndMs: number | null = null;

    if (entry.srtPath && await fileExists(entry.srtPath)) {
      const srtSha = await sha256File(entry.srtPath);
      const content = await readFile(entry.srtPath, "utf8");
      const cues = parseSrt(content);
      subtitleEndMs = cues.length > 0 ? cues[cues.length - 1]!.endMs : null;

      const [subtitleAsset] = await db.insert(schema.mediaAssets).values({
        kind: "subtitle",
        trainer: entry.trainer,
        title: `${entry.title} (SRT)`,
        localPath: entry.srtPath,
        sha256: srtSha,
        durationMs: null,
        probeStatus: "ok",
        bytes: 0,
      }).onConflictDoUpdate({
        target: [schema.mediaAssets.sha256, schema.mediaAssets.kind],
        set: {
          title: `${entry.title} (SRT)`,
          localPath: entry.srtPath,
          updatedAt: new Date(),
        },
      }).returning();
      subtitleId = subtitleAsset?.id ?? null;
    }

    let completeness: string;
    let gapSeconds: number | null = null;
    let usableUntilMs: number | null = null;

    if (!videoDuration || decode?.fullDecodeStatus === "failed") {
      completeness = "video_decode_error";
    } else if (decode?.fullDecodeStatus === "decode_errors") {
      completeness = "video_decode_error";
      usableUntilMs = minimumPositive(
        videoDuration,
        subtitleEndMs,
        decode.usableVideoUntilMs,
        decode.decodeErrorAtMs,
      );
    } else if (subtitleId === null) {
      completeness = "missing_subtitle";
    } else if (subtitleEndMs === null || subtitleEndMs <= 0) {
      completeness = "unverified";
    } else {
      gapSeconds = Math.round((videoDuration - subtitleEndMs) / 1000);
      if (gapSeconds > TRUNCATION_TOLERANCE_MS / 1000) {
        completeness = "subtitle_truncated";
        usableUntilMs = minimumPositive(
          subtitleEndMs,
          decode?.usableVideoUntilMs ?? videoDuration,
        );
      } else {
        completeness = "complete";
        // A complete subtitle may still end a few seconds before the video.
        // Never claim an evidence window beyond the final subtitle cue.
        usableUntilMs = minimumPositive(
          videoDuration,
          subtitleEndMs,
          decode?.usableVideoUntilMs ?? videoDuration,
        );
      }
    }

    const [pairing] = await db.insert(schema.mediaPairings).values({
      videoAssetId: videoAsset.id,
      subtitleAssetId: subtitleId,
      matchMethod: "manifest",
      completeness,
      subtitleEndMs,
      gapSeconds,
      usableUntilMs,
      notes: entry.notes ?? null,
    }).onConflictDoUpdate({
      target: schema.mediaPairings.videoAssetId,
      set: {
        subtitleAssetId: subtitleId,
        completeness,
        subtitleEndMs,
        gapSeconds,
        usableUntilMs,
        notes: entry.notes ?? null,
        updatedAt: new Date(),
      },
    }).returning();
    if (!pairing) throw new Error("pairing upsert returned no row");

    return { pairingId: pairing.id, completeness };
  }

  async function fileExists(p: string): Promise<boolean> {
    try {
      await readFile(p);
      return true;
    } catch {
      return false;
    }
  }

  return { importEntry };
}

function minimumPositive(...values: Array<number | null | undefined>): number | null {
  const candidates = values.filter(
    (value): value is number => value !== null && value !== undefined && Number.isFinite(value) && value > 0,
  );
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

export function defaultManifest(downloadsDir: string, douyinDir: string): ManifestVideo[] {
  const v = (name: string) => path.join(douyinDir, name);
  const s = (name: string) => path.join(downloadsDir, name);
  return [
    // 凯圣王: main program; the four ambiguous SRT names map by duration.
    { trainer: "kaishengwang", sourceRole: "main_program", title: "三分化①训练计划", localPath: v("凯圣王-【凯圣王-谭成义三分化①——训练计划】 我跟谭指导今年合作给兄弟姐妹们更新一个三分化系列，新手和训练_720p.mp4"), srtPath: s("凯圣王-【凯圣王-谭(3).srt"), notes: "duration-matched confirmed_mapping" },
    { trainer: "kaishengwang", sourceRole: "main_program", title: "三分化②跟练胸肩三头", localPath: v("凯圣王-【凯圣王-谭成义三分化②——跟练胸肩三头】 开始三分化跟练第一天胸肩三头，我跟谭指导带大家把第一天的_720p.mp4"), srtPath: s("凯圣王-【凯圣王-谭.srt") },
    { trainer: "kaishengwang", sourceRole: "main_program", title: "三分化④跟练背肩后束二头", localPath: v("凯圣王-【凯圣王-谭成义三分化④——跟练背三角肌后束二头】 三分化跟练第二天，我跟谭指导还有北理背王带大家过_720p.mp4"), srtPath: s("凯圣王-【凯圣王-谭(1).srt") },
    { trainer: "kaishengwang", sourceRole: "main_program", title: "三分化⑤跟练腿", localPath: v("凯圣王-【凯圣王-谭成义三分化⑤——跟练腿股四头肌腘绳肌】 三分化跟练第三天是练腿的内容，先由谭指导给大家带_720p.mp4"), srtPath: s("凯圣王-【凯圣王-谭(2).srt") },
    // 粗人: chest/bench specialist corrections.
    { trainer: "curun", sourceRole: "chest_specialist", title: "卧推找不到胸发力私教课", localPath: v("粗人(力量矩阵营养学)-【私教课跟练5期】我付费！您上课！请把这个视频发给你身边所有卧推找不到_胸_发力的人！全程高能一刀不_720p.mp4"), srtPath: s("粗人(力量矩阵营养学.srt") },
    // 谭成义: technique details, warmups, regressions.
    { trainer: "tanchengyi", sourceRole: "technique_details", title: "手臂教学第二期（SRT 截断）", localPath: v("谭成义-私教系列之手臂教学 第二期手臂教学来喽，视频依旧很长，希望对大家有所帮助…！视频无剪辑，所以有些小问_720p.mp4"), srtPath: s("谭成义-私教系列之手.srt") },
    { trainer: "tanchengyi", sourceRole: "technique_details", title: "手臂训练二", localPath: v("谭成义-私教系列之手臂训练（二） 可作为手臂二练的训练内容，也可以当成一练内容，大家可以参考一下，希望对大家_720p.mp4"), srtPath: s("谭成义-私教系列之手第二部分.srt") },
    { trainer: "tanchengyi", sourceRole: "technique_details", title: "肩部教学", localPath: v("谭成义-私教系列之肩部教学 紧赶慢赶终于把肩部教学出来了，依旧长视频无剪辑，希望大家有所帮助！！#肩部训练_720p.mp4"), srtPath: s("谭成义-私教系列之肩.srt") },
    { trainer: "tanchengyi", sourceRole: "technique_details", title: "胸部教学（SRT 截断）", localPath: v("谭成义-私教系列之胸部教学 第三期私教系列来喽，依旧长视频希望对大家有所帮助！！#胸部训练 #增肌_720p.mp4"), srtPath: s("谭成义-私教系列之胸.srt") },
    { trainer: "tanchengyi", sourceRole: "technique_details", title: "腹肌教学", localPath: v("谭成义-私教系列之腹肌教学 希望大家对于腹肌有新的认识，对大家有所帮助！！#腹肌 #核心_720p.mp4"), srtPath: s("谭成义-私教系列之腹.srt") },
    { trainer: "tanchengyi", sourceRole: "technique_details", title: "腿部训练", localPath: v("谭成义-私教系列之腿部训练 依旧长视频，希望对大家下肢训练有所帮助！！#下肢力量  #腿部训练_720p.mp4"), srtPath: s("谭成义-私教系列之腿.srt") },
    { trainer: "tanchengyi", sourceRole: "technique_details", title: "背部跟练", localPath: v("谭成义-私教跟练系列背部训练 #力量训练_720p.mp4"), srtPath: s("谭成义-私教系列之背.srt") },
  ];
}
