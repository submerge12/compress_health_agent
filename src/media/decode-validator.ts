/**
 * WO-HS-09 / M23: deep video integrity validation.
 *
 * `probeDurationMs` only proves the container header is readable. Here we
 * run a full decode (`ffmpeg -v error -i x -f null -`) to detect corruption
 * partway through, recording WHERE it failed. Large files may use keyframe
 * sampling, but known-suspicious files must be fully decoded.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DecodeValidation {
  fullDecodeStatus: "ok" | "decode_errors" | "failed";
  /** Timestamp of the first decode error, when any. */
  decodeErrorAtMs: number | null;
  /** Video is usable only up to here (duration if fully clean). */
  usableVideoUntilMs: number | null;
}

/** Parse the first `time=` marker out of ffmpeg stderr. */
function firstErrorTimeMs(stderr: string): number | null {
  const m = /time=(\d{1,2}):(\d{2}):(\d{2})\.(\d{1,3})/.exec(stderr);
  if (m === null || m[4] === undefined) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const ms = Number(m[4].padEnd(3, "0"));
  return ((h * 60 + min) * 60 + sec) * 1000 + ms;
}

/**
 * Full-decode validation via `ffmpeg -v error -i input -f null -`.
 * Every decoded frame passes through; any error means corruption.
 */
export async function validateFullDecode(
  filePath: string,
  options?: { timeoutSeconds?: number },
): Promise<DecodeValidation> {
  try {
    await execFileAsync(
      "ffmpeg",
      ["-v", "error", "-xerror", "-i", filePath, "-f", "null", "-"],
      { timeout: (options?.timeoutSeconds ?? 300) * 1000, maxBuffer: 16 * 1024 * 1024 },
    );
    // No errors: file decodes completely. Determine duration for usable-until.
    let durationMs: number | null = null;
    try {
      const probe = await execFileAsync(
        "ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
        { timeout: 30_000 },
      );
      const seconds = Number(probe.stdout.trim());
      if (Number.isFinite(seconds) && seconds > 0) durationMs = Math.round(seconds * 1000);
    } catch {
      // duration unknown; still fully decodable
    }
    return { fullDecodeStatus: "ok", decodeErrorAtMs: null, usableVideoUntilMs: durationMs };
  } catch (error) {
    const err = error as { code?: number; stderr?: string; killed?: boolean; message?: string };
    const stderr = err.stderr ?? "";
    const atMs = firstErrorTimeMs(stderr);

    if (err.killed || (err.code === undefined && !stderr)) {
      // Timeout or spawn failure - treat as failed validation, not corruption.
      return { fullDecodeStatus: "failed", decodeErrorAtMs: null, usableVideoUntilMs: null };
    }
    return {
      fullDecodeStatus: "decode_errors",
      decodeErrorAtMs: atMs,
      usableVideoUntilMs: atMs,
    };
  } finally {
    void execFileAsync;
  }
}
