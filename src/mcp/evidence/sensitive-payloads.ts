import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

import { and, eq, isNull, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../../db/schema.js";
import { redactEvidenceRecord } from "./privacy-policy.js";

type Db = PostgresJsDatabase<typeof schema>;

export interface SensitivePayloadServiceOptions {
  /** Deployment-managed secret. When absent, raw text is dropped, never stored. */
  encryptionKey?: string | null;
  keyVersion?: string;
  now?: () => Date;
}

export class SensitivePayloadAccessError extends Error {
  readonly code = "sensitive_payload_access_denied";
  constructor(readonly reason: string) {
    super(`sensitive payload access denied: ${reason}`);
  }
}

export function createSensitivePayloadService(
  db: Db,
  options: SensitivePayloadServiceOptions = {},
) {
  const encryptionSecret = options.encryptionKey === null
    ? undefined
    : options.encryptionKey ?? process.env["COMPASS_HEALTH_SENSITIVE_PAYLOAD_KEY"];
  const keyVersion = options.keyVersion
    ?? process.env["COMPASS_HEALTH_SENSITIVE_PAYLOAD_KEY_VERSION"]
    ?? "v1";
  const key = encryptionSecret === undefined ? undefined : deriveEncryptionKey(encryptionSecret);
  const now = options.now ?? (() => new Date());

  async function protectText(input: {
    userId: string;
    payloadType: string;
    plaintext: string;
    retentionDays: number;
    metadata?: Record<string, unknown>;
  }): Promise<{
    evidenceText: string;
    payloadId: string | null;
    contentHash: string;
    contentLength: number;
  }> {
    const contentHash = createHash("sha256").update(input.plaintext, "utf8").digest("hex");
    const contentLength = Buffer.byteLength(input.plaintext, "utf8");
    const baseEvidence = `type=${input.payloadType};length=${contentLength};sha256=${contentHash}`;
    if (key === undefined || input.retentionDays <= 0) {
      return {
        evidenceText: `<sensitive:${baseEvidence};retained=false>`,
        payloadId: null,
        contentHash,
        contentLength,
      };
    }

    const payloadId = randomUUID();
    const retentionUntil = new Date(now().getTime() + input.retentionDays * 86_400_000);
    const ciphertext = encrypt({
      plaintext: input.plaintext,
      key,
      aad: payloadAad(payloadId, input.userId, input.payloadType, keyVersion),
    });
    await db.insert(schema.sensitivePayloads).values({
      id: payloadId,
      userId: input.userId,
      payloadType: input.payloadType,
      ciphertext,
      keyVersion,
      contentHash,
      contentLength,
      metadataJson: redactEvidenceRecord(input.metadata),
      retentionUntil,
    });
    return {
      evidenceText: `<sensitive:${baseEvidence};ref=${payloadId}>`,
      payloadId,
      contentHash,
      contentLength,
    };
  }

  async function grantReviewerAccess(input: {
    userId: string;
    payloadId: string;
    reviewerActorId: string;
    grantedByActorId: string;
  }): Promise<void> {
    const [payload, reviewer, grantor] = await Promise.all([
      activePayload(input.userId, input.payloadId),
      actorById(input.reviewerActorId),
      actorById(input.grantedByActorId),
    ]);
    if (!payload) throw new SensitivePayloadAccessError("payload_not_found_or_not_owned");
    if (reviewer?.actorType !== "reviewer") {
      throw new SensitivePayloadAccessError("requester_not_reviewer");
    }
    if (!grantor || !["codex", "reviewer"].includes(grantor.actorType)) {
      throw new SensitivePayloadAccessError("grantor_not_authorized");
    }
    await db.insert(schema.sensitivePayloadAccessGrants).values({
      payloadId: input.payloadId,
      reviewerActorId: input.reviewerActorId,
      grantedByActorId: input.grantedByActorId,
    }).onConflictDoUpdate({
      target: [
        schema.sensitivePayloadAccessGrants.payloadId,
        schema.sensitivePayloadAccessGrants.reviewerActorId,
      ],
      set: {
        grantedByActorId: input.grantedByActorId,
        revokedAt: null,
        updatedAt: now(),
      },
    });
  }

  async function readForReviewer(input: {
    userId: string;
    payloadId: string;
    reviewerActorId: string;
  }): Promise<{
    plaintext: string;
    payloadType: string;
    metadata: Record<string, unknown>;
  }> {
    const reviewer = await actorById(input.reviewerActorId);
    if (reviewer?.actorType !== "reviewer") {
      throw new SensitivePayloadAccessError("requester_not_reviewer");
    }
    const payload = await activePayload(input.userId, input.payloadId);
    if (!payload || payload.deletedAt !== null || payload.retentionUntil <= now()) {
      throw new SensitivePayloadAccessError("payload_expired_or_deleted");
    }
    const [grant] = await db.select({ id: schema.sensitivePayloadAccessGrants.id })
      .from(schema.sensitivePayloadAccessGrants)
      .where(and(
        eq(schema.sensitivePayloadAccessGrants.payloadId, input.payloadId),
        eq(schema.sensitivePayloadAccessGrants.reviewerActorId, input.reviewerActorId),
        isNull(schema.sensitivePayloadAccessGrants.revokedAt),
      ))
      .limit(1);
    if (!grant) throw new SensitivePayloadAccessError("reviewer_grant_missing");
    if (key === undefined || payload.keyVersion !== keyVersion || payload.ciphertext === null) {
      throw new SensitivePayloadAccessError("key_unavailable");
    }
    const plaintext = decrypt({
      ciphertext: payload.ciphertext,
      key,
      aad: payloadAad(payload.id, payload.userId, payload.payloadType, payload.keyVersion),
    });
    await db.insert(schema.interactionEvents).values({
      userId: input.userId,
      actor: `sensitive-reviewer:${input.reviewerActorId}`,
      stage: "evidence",
      stageCode: "sensitive_payload_read",
      detailJson: { payloadId: input.payloadId, payloadType: payload.payloadType },
    });
    return { plaintext, payloadType: payload.payloadType, metadata: payload.metadataJson };
  }

  async function purgeExpired(at = now()): Promise<number> {
    const purged = await db.update(schema.sensitivePayloads)
      .set({ ciphertext: null, deletedAt: at, updatedAt: at })
      .where(and(
        isNull(schema.sensitivePayloads.deletedAt),
        lte(schema.sensitivePayloads.retentionUntil, at),
      ))
      .returning({ id: schema.sensitivePayloads.id });
    return purged.length;
  }

  async function activePayload(userId: string, payloadId: string) {
    const [payload] = await db.select().from(schema.sensitivePayloads)
      .where(and(
        eq(schema.sensitivePayloads.id, payloadId),
        eq(schema.sensitivePayloads.userId, userId),
      ))
      .limit(1);
    return payload;
  }

  async function actorById(actorId: string) {
    const [actor] = await db.select().from(schema.agentActors)
      .where(and(eq(schema.agentActors.id, actorId), eq(schema.agentActors.status, "active")))
      .limit(1);
    return actor;
  }

  return { protectText, grantReviewerAccess, readForReviewer, purgeExpired };
}

function deriveEncryptionKey(secret: string): Buffer {
  if (secret.trim().length < 32) {
    throw new RangeError("COMPASS_HEALTH_SENSITIVE_PAYLOAD_KEY must contain at least 32 characters");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

function payloadAad(id: string, userId: string, payloadType: string, keyVersion: string): Buffer {
  return Buffer.from([id, userId, payloadType, keyVersion].join("\u001f"), "utf8");
}

function encrypt(input: { plaintext: string; key: Buffer; aad: Buffer }): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(input.aad);
  const encrypted = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
  return ["aes-256-gcm", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
}

function decrypt(input: { ciphertext: string; key: Buffer; aad: Buffer }): string {
  const [algorithm, ivValue, tagValue, encryptedValue] = input.ciphertext.split(":");
  if (algorithm !== "aes-256-gcm" || !ivValue || !tagValue || encryptedValue === undefined) {
    throw new SensitivePayloadAccessError("ciphertext_invalid");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", input.key, Buffer.from(ivValue, "base64url"));
    decipher.setAAD(input.aad);
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SensitivePayloadAccessError("ciphertext_invalid");
  }
}
