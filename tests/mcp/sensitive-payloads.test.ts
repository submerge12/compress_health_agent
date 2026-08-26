import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../src/db/schema.js";
import {
  createSensitivePayloadService,
  SensitivePayloadAccessError,
} from "../../src/mcp/evidence/sensitive-payloads.js";
import { SENSITIVE_RETENTION_POLICY } from "../../src/mcp/evidence/privacy-policy.js";
import { createRunHandleService } from "../../src/mcp/evidence/run-handles.js";
import { resolveActor } from "../../src/mcp/auth/actor-registry.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://compass:compass@localhost:5433/compass_health";
const isDbAvailable = await postgres(DATABASE_URL, { max: 1, connect_timeout: 3 })
  .unsafe("SELECT 1")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!isDbAvailable)("sensitive evidence payloads", () => {
  const pool = postgres(DATABASE_URL, { max: 4, prepare: false });
  const db = drizzle(pool, { schema });
  const now = new Date("2026-08-26T00:00:00.000Z");
  const actorIds: string[] = [];
  let userId: string;
  let codexActorId: string;
  let reviewerActorId: string;
  let managerActorId: string;
  const sensitiveOptions = {
    encryptionKey: "test-only-sensitive-payload-key-with-at-least-32-characters",
    keyVersion: "test-v1",
    now: () => now,
  } as const;
  const service = createSensitivePayloadService(db, sensitiveOptions);

  beforeAll(async () => {
    const [user] = await db.insert(schema.users).values({
      externalId: `sensitive-payload-${process.pid}-${Date.now()}`,
    }).returning({ id: schema.users.id });
    if (!user) throw new Error("sensitive payload test user setup failed");
    userId = user.id;

    const createActor = async (actorType: string) => {
      const [actor] = await db.insert(schema.agentActors).values({
        bindingKey: `sensitive-payload-${actorType}-${process.pid}-${Date.now()}-${crypto.randomUUID()}`,
        actorType,
        runtimeName: `privacy-test-${actorType}`,
        agentProfile: `privacy-test-${actorType}`,
      }).returning({ id: schema.agentActors.id });
      if (!actor) throw new Error(`sensitive payload ${actorType} actor setup failed`);
      actorIds.push(actor.id);
      return actor.id;
    };
    codexActorId = await createActor("codex");
    reviewerActorId = await createActor("reviewer");
    managerActorId = await createActor("manager");
  });

  afterAll(async () => {
    if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
    if (actorIds.length > 0) {
      await db.delete(schema.agentActors).where(inArray(schema.agentActors.id, actorIds));
    }
    await pool.end({ timeout: 3 });
  });

  it("stores only ciphertext metadata and requires an explicit reviewer grant", async () => {
    const plaintext = "right shoulder sharp pain after the third repetition";
    const protectedText = await service.protectText({
      userId,
      payloadType: "agent_objective",
      plaintext,
      retentionDays: 30,
      metadata: { bodyPart: "right_shoulder", severity: "sharp" },
    });
    expect(protectedText.payloadId).toEqual(expect.any(String));
    expect(protectedText.evidenceText).not.toContain(plaintext);

    const [stored] = await db.select().from(schema.sensitivePayloads)
      .where(eq(schema.sensitivePayloads.id, protectedText.payloadId!));
    expect(stored).toMatchObject({
      userId,
      payloadType: "agent_objective",
      keyVersion: "test-v1",
      contentLength: plaintext.length,
      metadataJson: { bodyPart: "right_shoulder", severity: "sharp" },
    });
    expect(stored?.ciphertext).not.toContain(plaintext);
    expect(stored?.contentHash).toMatch(/^[a-f0-9]{64}$/);

    await expect(service.readForReviewer({
      userId,
      payloadId: protectedText.payloadId!,
      reviewerActorId,
    })).rejects.toBeInstanceOf(SensitivePayloadAccessError);
    await expect(service.grantReviewerAccess({
      userId,
      payloadId: protectedText.payloadId!,
      reviewerActorId: managerActorId,
      grantedByActorId: codexActorId,
    })).rejects.toMatchObject({ reason: "requester_not_reviewer" });

    await service.grantReviewerAccess({
      userId,
      payloadId: protectedText.payloadId!,
      reviewerActorId,
      grantedByActorId: codexActorId,
    });
    await expect(service.readForReviewer({
      userId,
      payloadId: protectedText.payloadId!,
      reviewerActorId: managerActorId,
    })).rejects.toMatchObject({ reason: "requester_not_reviewer" });
    await expect(service.readForReviewer({
      userId,
      payloadId: protectedText.payloadId!,
      reviewerActorId,
    })).resolves.toMatchObject({ plaintext, payloadType: "agent_objective" });
  });

  it("crypto-shreds expired payloads while retaining non-sensitive audit metadata", async () => {
    const protectedText = await service.protectText({
      userId,
      payloadType: "raw_transcript",
      plaintext: "private raw ASR transcript",
      retentionDays: 1,
    });
    await service.grantReviewerAccess({
      userId,
      payloadId: protectedText.payloadId!,
      reviewerActorId,
      grantedByActorId: codexActorId,
    });

    const purged = await service.purgeExpired(new Date("2026-08-28T00:00:00.000Z"));
    expect(purged).toBeGreaterThanOrEqual(1);
    const [stored] = await db.select().from(schema.sensitivePayloads)
      .where(eq(schema.sensitivePayloads.id, protectedText.payloadId!));
    expect(stored?.ciphertext).toBeNull();
    expect(stored?.deletedAt).toBeInstanceOf(Date);
    expect(stored?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(service.readForReviewer({
      userId,
      payloadId: protectedText.payloadId!,
      reviewerActorId,
    })).rejects.toMatchObject({ reason: "payload_expired_or_deleted" });
  });

  it("keeps run objective and response summary plaintext out of agent_runs", async () => {
    const actorLabel = `privacy-run-codex-${process.pid}-${Date.now()}`;
    const actorProfile = {
      actorType: "codex",
      runtimeName: "privacy-run-test",
      runtimeVersion: crypto.randomUUID(),
      agentProfile: actorLabel,
    };
    const actor = await resolveActor(db, { actor: actorLabel, actorProfile });
    actorIds.push(actor.id);
    const runs = createRunHandleService(db, { sensitivePayloads: sensitiveOptions });
    const objective = "investigate private sleep and shoulder pain narrative";
    const responseSummary = "private summary says shoulder pain remained sharp";
    const begun = await runs.beginRun({
      userId,
      objective,
      actor: actorLabel,
      actorId: actor.id,
      actorProfile,
    });
    await runs.endRun({
      userId,
      runHandle: begun.runHandle,
      outcome: "completed",
      responseSummary,
    });

    const [stored] = await db.select().from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, begun.runHandle));
    expect(stored?.objective).not.toContain(objective);
    expect(stored?.responseSummary).not.toContain(responseSummary);
    expect(stored?.objectivePayloadId).toEqual(expect.any(String));
    expect(stored?.responseSummaryPayloadId).toEqual(expect.any(String));
    const serialized = JSON.stringify(await runs.getRun(userId, begun.runHandle, actor.id));
    expect(serialized).not.toContain(objective);
    expect(serialized).not.toContain(responseSummary);
  });

  it("drops raw text when no encryption key is configured", async () => {
    const keyless = createSensitivePayloadService(db, { encryptionKey: null, now: () => now });
    const plaintext = "do not retain this private objective";
    const protectedText = await keyless.protectText({
      userId,
      payloadType: "agent_objective",
      plaintext,
      retentionDays: 30,
    });
    expect(protectedText.payloadId).toBeNull();
    expect(protectedText.evidenceText).not.toContain(plaintext);
  });

  it("defines ASR and evidence retention defaults explicitly", () => {
    expect(SENSITIVE_RETENTION_POLICY.rawAudio).toMatchObject({ retain: false, days: 0 });
    expect(SENSITIVE_RETENTION_POLICY.rawTranscript.days).toBeLessThanOrEqual(1);
    expect(SENSITIVE_RETENTION_POLICY.correctedTranscript.persistInEvidence).toBe(false);
    expect(SENSITIVE_RETENTION_POLICY.agentEvidence.containsRawFreeText).toBe(false);
  });
});
