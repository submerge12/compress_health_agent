import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { and, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema.js";
import {
  createSignedStreamUrlService,
  type MediaStreamUrlIssuer,
} from "./signed-stream-url.js";

type Db = PostgresJsDatabase<typeof schema>;
const MAX_RENDERED_SEGMENT_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_SEGMENTS = 4;

export type MediaRuntimeMode = "embedded" | "external" | "off";

export interface MediaRuntimeHandle {
  mode: MediaRuntimeMode;
  baseUrl: string | null;
  issueStreamUrl: MediaStreamUrlIssuer | null;
  stop(): Promise<void>;
}

export async function startMediaRuntime(options: {
  db: Db;
  mode: MediaRuntimeMode;
  baseUrl?: string;
  signingSecret?: string;
  ffmpegPath?: string;
  ttlMs?: number;
  now?: () => Date;
}): Promise<MediaRuntimeHandle> {
  if (options.mode === "off") {
    return { mode: "off", baseUrl: null, issueStreamUrl: null, stop: async () => undefined };
  }

  if (options.mode === "external") {
    if (!options.baseUrl) throw new RangeError("COMPASS_HEALTH_MEDIA_BASE_URL is required in external mode");
    if (!options.signingSecret) {
      throw new RangeError("COMPASS_HEALTH_MEDIA_SIGNING_SECRET is required in external mode");
    }
    const signed = createSignedStreamUrlService({
      baseUrl: options.baseUrl,
      secret: options.signingSecret,
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    return {
      mode: "external",
      baseUrl: options.baseUrl,
      issueStreamUrl: signed.issue,
      stop: async () => undefined,
    };
  }

  const requested = embeddedAddress(options.baseUrl);
  const secret = options.signingSecret ?? randomBytes(32).toString("hex");
  const ffmpegPath = options.ffmpegPath?.trim() || "ffmpeg";
  await assertFfmpegAvailable(ffmpegPath);
  const renderer = createSegmentRenderer(ffmpegPath);
  let signed = createSignedStreamUrlService({
    baseUrl: `http://127.0.0.1:${requested.port}`,
    secret,
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const server = createServer((request, response) => {
    void serveMedia(options.db, signed, renderer, request, response).catch(() => {
      if (!response.headersSent) send(response, 500, "media runtime failure");
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requested.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("embedded media runtime has no listen address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  signed = createSignedStreamUrlService({
    baseUrl,
    secret,
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  return {
    mode: "embedded",
    baseUrl,
    issueStreamUrl: signed.issue,
    stop: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        renderer.clear();
        error ? reject(error) : resolve();
      });
    }),
  };
}

async function serveMedia(
  db: Db,
  signed: ReturnType<typeof createSignedStreamUrlService>,
  renderer: SegmentRenderer,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    send(response, 405, "method not allowed");
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const match = /^\/api\/v1\/media\/segments\/([0-9a-f-]+)\/stream$/iu.exec(url.pathname);
  if (!match?.[1]) {
    send(response, 404, "not found");
    return;
  }
  const segmentId = match[1];
  const verification = signed.verify(
    segmentId,
    url.searchParams.get("expires"),
    url.searchParams.get("signature"),
  );
  if (verification !== "ok") {
    send(response, verification === "expired" ? 410 : 403, verification);
    return;
  }

  const [row] = await db.select({
    segmentStartMs: schema.videoSegments.startMs,
    segmentEndMs: schema.videoSegments.endMs,
    subtitleEndMs: schema.mediaPairings.subtitleEndMs,
    pairingUsableUntilMs: schema.mediaPairings.usableUntilMs,
    localPath: schema.mediaAssets.localPath,
    durationMs: schema.mediaAssets.durationMs,
    usableVideoUntilMs: schema.mediaAssets.usableVideoUntilMs,
    decodeErrorAtMs: schema.mediaAssets.decodeErrorAtMs,
    probeStatus: schema.mediaAssets.probeStatus,
    fullDecodeStatus: schema.mediaAssets.fullDecodeStatus,
    contentType: schema.mediaAssets.contentType,
  }).from(schema.videoSegments)
    .innerJoin(schema.mediaPairings, eq(schema.videoSegments.pairingId, schema.mediaPairings.id))
    .innerJoin(schema.mediaAssets, eq(schema.mediaPairings.videoAssetId, schema.mediaAssets.id))
    .where(and(
      eq(schema.videoSegments.id, segmentId),
      isNull(schema.videoSegments.supersededById),
    ))
    .limit(1);
  if (!row || row.probeStatus !== "ok" || !["ok", "decode_errors"].includes(row.fullDecodeStatus)) {
    send(response, 404, "media unavailable");
    return;
  }
  const assetLimit = row.fullDecodeStatus === "ok"
    ? (row.usableVideoUntilMs ?? row.durationMs)
    : minimumPositive(row.usableVideoUntilMs, row.decodeErrorAtMs);
  const safetyLimit = row.subtitleEndMs === null || row.pairingUsableUntilMs === null || assetLimit === null
    ? null
    : minimumPositive(row.subtitleEndMs, row.pairingUsableUntilMs, assetLimit);
  if (safetyLimit === null || row.segmentEndMs > safetyLimit) {
    send(response, 404, "segment outside usable media window");
    return;
  }

  let representation: Buffer;
  try {
    representation = await renderer.render({
      segmentId,
      localPath: row.localPath,
      startMs: row.segmentStartMs,
      endMs: row.segmentEndMs,
    });
  } catch {
    send(response, 503, "media segment unavailable");
    return;
  }
  const totalBytes = representation.byteLength;
  if (totalBytes <= 0) {
    send(response, 416, "empty media window");
    return;
  }
  const requested = parseRange(request.headers.range, totalBytes);
  if (requested === null) {
    response.writeHead(416, { "Content-Range": `bytes */${totalBytes}` });
    response.end();
    return;
  }
  response.writeHead(requested.partial ? 206 : 200, {
    "Content-Type": row.contentType,
    "Content-Length": String(requested.end - requested.start + 1),
    "Accept-Ranges": "bytes",
    ...(requested.partial
      ? { "Content-Range": `bytes ${requested.start}-${requested.end}/${totalBytes}` }
      : {}),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(representation.subarray(requested.start, requested.end + 1));
}

interface SegmentRenderer {
  render(input: {
    segmentId: string;
    localPath: string;
    startMs: number;
    endMs: number;
  }): Promise<Buffer>;
  clear(): void;
}

/**
 * Render one independently playable fragmented MP4 for the exact segment
 * window. Byte/time ratios are invalid for variable-bitrate media and can cut
 * away MP4 headers or keyframes, so the bounded representation is produced by
 * decoding and re-encoding the selected time range.
 */
function createSegmentRenderer(ffmpegPath: string): SegmentRenderer {
  const cache = new Map<string, Promise<Buffer>>();
  return {
    async render(input) {
      if (input.startMs < 0 || input.endMs <= input.startMs) {
        throw new RangeError("invalid media segment time window");
      }
      const key = `${input.segmentId}:${input.startMs}:${input.endMs}`;
      const existing = cache.get(key);
      if (existing) {
        cache.delete(key);
        cache.set(key, existing);
        return existing;
      }
      const pending = renderMp4Window(ffmpegPath, input);
      cache.set(key, pending);
      while (cache.size > MAX_CACHED_SEGMENTS) {
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      try {
        return await pending;
      } catch (error) {
        if (cache.get(key) === pending) cache.delete(key);
        throw error;
      }
    },
    clear() {
      cache.clear();
    },
  };
}

async function renderMp4Window(
  ffmpegPath: string,
  input: { localPath: string; startMs: number; endMs: number },
): Promise<Buffer> {
  const durationMs = input.endMs - input.startMs;
  return runBinary(ffmpegPath, [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-i", input.localPath,
    "-ss", seconds(input.startMs),
    "-t", seconds(durationMs),
    "-map", "0:v:0?",
    "-map", "0:a:0?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-c:a", "aac",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    "pipe:1",
  ], MAX_RENDERED_SEGMENT_BYTES);
}

async function assertFfmpegAvailable(ffmpegPath: string): Promise<void> {
  // Exercise the same video/audio encoders and fragmented-MP4 muxer used by
  // real requests. A version-only probe can pass even when libx264 or AAC was
  // omitted from a custom FFmpeg build.
  await runBinary(ffmpegPath, [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", "color=c=black:s=16x16:r=25:d=0.08",
    "-f", "lavfi",
    "-i", "anullsrc=r=44100:cl=mono",
    "-t", "0.08",
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    "pipe:1",
  ], 1024 * 1024, 10_000);
}

function runBinary(command: string, args: string[], maxBytes: number, timeoutMs = 120_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let overflowed = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxBytes) {
        overflowed = true;
        child.kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error("ffmpeg timed out"));
      } else if (overflowed) {
        reject(new Error("rendered media segment exceeds memory limit"));
      } else if (code !== 0) {
        reject(new Error(`ffmpeg failed with exit ${code}: ${stderr.slice(0, 500)}`));
      } else {
        resolve(Buffer.concat(stdout, stdoutBytes));
      }
    });
  });
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1_000).toFixed(3);
}

function embeddedAddress(baseUrl: string | undefined): { port: number } {
  if (!baseUrl) return { port: 0 };
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:") throw new RangeError("embedded media base URL must use http");
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new RangeError("embedded media runtime must use a loopback host");
  }
  const port = parsed.port === "" ? 80 : Number(parsed.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new RangeError("invalid media runtime port");
  return { port };
}

function parseRange(header: string | undefined, total: number): {
  start: number;
  end: number;
  partial: boolean;
} | null {
  if (!header) return { start: 0, end: total - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(total - suffixLength, 0);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? total - 1 : Math.min(Number(match[2]), total - 1);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= total) {
    return null;
  }
  return { start, end, partial: true };
}

function minimumPositive(...values: Array<number | null | undefined>): number | null {
  const finite = values.filter(
    (value): value is number => value !== null && value !== undefined && Number.isFinite(value) && value > 0,
  );
  return finite.length > 0 ? Math.min(...finite) : null;
}

function send(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(message);
}
