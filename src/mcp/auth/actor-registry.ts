import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../../db/schema.js";

type Db = PostgresJsDatabase<typeof schema>;

export interface ActorProfileInput {
  actorType?: string | null;
  runtimeName?: string | null;
  runtimeVersion?: string | null;
  agentProfile?: string | null;
  agentProfileVersion?: string | null;
  modelProvider?: string | null;
  modelName?: string | null;
}

export interface VerifiedActorProfile {
  verifiedActor: string;
  actorType: string;
  runtimeName: string;
  runtimeVersion: string | null;
  agentProfile: string;
  agentProfileVersion: string | null;
  modelProvider: string | null;
  modelName: string | null;
}

export interface ResolvedActor extends VerifiedActorProfile {
  id: string;
  status: string;
}

export interface ActorConfiguration {
  actor?: string;
  actorProfile?: ActorProfileInput;
}

/**
 * Convert startup configuration into one stable, fully attributed actor.
 * Request metadata is deliberately absent from this interface.
 */
export function normalizeActorProfile(options: ActorConfiguration): VerifiedActorProfile {
  const configured = options.actorProfile ?? {};
  const verifiedActor = clean(options.actor)
    ?? clean(configured.agentProfile)
    ?? "codex-primary";
  const actorType = clean(configured.actorType) ?? inferActorType(verifiedActor);
  return {
    verifiedActor,
    actorType,
    runtimeName: clean(configured.runtimeName) ?? defaultRuntimeName(actorType, verifiedActor),
    runtimeVersion: clean(configured.runtimeVersion) ?? null,
    agentProfile: clean(configured.agentProfile) ?? verifiedActor,
    agentProfileVersion: clean(configured.agentProfileVersion) ?? null,
    modelProvider: clean(configured.modelProvider) ?? null,
    modelName: clean(configured.modelName) ?? null,
  };
}

/** Resolve-or-create is concurrency safe across STDIO processes and instances. */
export async function resolveActor(db: Db, options: ActorConfiguration): Promise<ResolvedActor> {
  const profile = normalizeActorProfile(options);
  const bindingKey = actorBindingKey(profile);
  await db.insert(schema.agentActors).values({
    bindingKey,
    actorType: profile.actorType,
    runtimeName: profile.runtimeName,
    runtimeVersion: profile.runtimeVersion,
    agentProfile: profile.agentProfile,
    agentProfileVersion: profile.agentProfileVersion,
    modelProvider: profile.modelProvider,
    modelName: profile.modelName,
    status: "active",
  }).onConflictDoNothing({ target: schema.agentActors.bindingKey });

  const [actor] = await db.select().from(schema.agentActors)
    .where(eq(schema.agentActors.bindingKey, bindingKey))
    .limit(1);
  if (!actor) throw new Error("formal actor resolution returned no row");
  if (actor.status !== "active") {
    throw new Error(`formal actor is ${actor.status}`);
  }
  return {
    id: actor.id,
    verifiedActor: profile.verifiedActor,
    actorType: actor.actorType,
    runtimeName: actor.runtimeName ?? profile.runtimeName,
    runtimeVersion: actor.runtimeVersion,
    agentProfile: actor.agentProfile ?? profile.agentProfile,
    agentProfileVersion: actor.agentProfileVersion,
    modelProvider: actor.modelProvider,
    modelName: actor.modelName,
    status: actor.status,
  };
}

function actorBindingKey(profile: VerifiedActorProfile): string {
  const canonical = [
    profile.actorType,
    profile.runtimeName,
    profile.runtimeVersion ?? "",
    profile.agentProfile,
    profile.agentProfileVersion ?? "",
    profile.modelProvider ?? "",
    profile.modelName ?? "",
  ].join("\u001f");
  return createHash("sha256").update(canonical).digest("hex");
}

function clean(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function inferActorType(actor: string): string {
  const normalized = actor.toLowerCase();
  if (normalized.startsWith("codex")) return "codex";
  if (normalized.startsWith("pi")) return "pi";
  if (normalized.startsWith("dsh")) return "dsh";
  if (normalized.includes("review")) return "reviewer";
  return "other";
}

function defaultRuntimeName(actorType: string, actor: string): string {
  return actorType === "other" ? actor : actorType;
}
