import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 5 * 60_000;

export interface StreamUrlDescriptor {
  streamUrl: string;
  expiresAt: string;
}

export type MediaStreamUrlIssuer = (segmentId: string) => StreamUrlDescriptor;

export interface SignedStreamUrlService {
  issue: MediaStreamUrlIssuer;
  verify(segmentId: string, expires: string | null, signature: string | null): "ok" | "expired" | "invalid";
}

export function createSignedStreamUrlService(options: {
  baseUrl: string;
  secret: string | Uint8Array;
  ttlMs?: number;
  now?: () => Date;
}): SignedStreamUrlService {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const secret = typeof options.secret === "string"
    ? Buffer.from(options.secret, "utf8")
    : Buffer.from(options.secret);
  if (secret.byteLength < 32) throw new RangeError("media signing secret must contain at least 32 bytes");
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs < 1_000) throw new RangeError("media URL TTL must be at least one second");
  const now = options.now ?? (() => new Date());

  function issue(segmentId: string): StreamUrlDescriptor {
    assertSegmentId(segmentId);
    const expiresAt = new Date(now().getTime() + ttlMs);
    const expires = String(Math.floor(expiresAt.getTime() / 1_000));
    const url = new URL(`/api/v1/media/segments/${encodeURIComponent(segmentId)}/stream`, baseUrl);
    url.searchParams.set("expires", expires);
    url.searchParams.set("signature", sign(segmentId, expires, secret));
    return { streamUrl: url.toString(), expiresAt: expiresAt.toISOString() };
  }

  function verify(
    segmentId: string,
    expires: string | null,
    signature: string | null,
  ): "ok" | "expired" | "invalid" {
    if (!isSegmentId(segmentId) || expires === null || signature === null || !/^\d+$/.test(expires)) {
      return "invalid";
    }
    const expiresSeconds = Number(expires);
    if (!Number.isSafeInteger(expiresSeconds)) return "invalid";
    if (expiresSeconds * 1_000 <= now().getTime()) return "expired";
    const expected = Buffer.from(sign(segmentId, expires, secret), "hex");
    let supplied: Buffer;
    try {
      supplied = Buffer.from(signature, "hex");
    } catch {
      return "invalid";
    }
    return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected)
      ? "ok"
      : "invalid";
  }

  return { issue, verify };
}

function sign(segmentId: string, expires: string, secret: Buffer): string {
  return createHmac("sha256", secret)
    .update(`compass-health-media-v1\n${segmentId}\n${expires}`)
    .digest("hex");
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new RangeError("media base URL must use http or https");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function assertSegmentId(value: string): void {
  if (!isSegmentId(value)) throw new RangeError("segment id must be a UUID");
}

function isSegmentId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
