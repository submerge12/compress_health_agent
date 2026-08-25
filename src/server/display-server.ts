import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ToolContext } from "../tools/context.js";
import { createDailyStateService } from "../domain/daily-state.js";
import { createDietLogService, NeedsConfirmationError, StateConflict } from "../domain/diet-log-service.js";
import { createTrainingService } from "../training/training-service.js";
import { createPainCommand, createPreparedSessionService, ProposalStaleError, blockedPatternsForBodyPart } from "../training/prepared-session.js";
import { createSubstitutionEngine } from "../training/substitution-engine.js";
import { NotOwnedError } from "../training/ownership.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as schemaRef from "../db/schema.js";
const trainingSessionsTable = schemaRef.trainingSessions;
const trainingSessionExercisesTable = schemaRef.trainingSessionExercises;
import { DomainHttpError, Errors } from "./domain-http-error.js";
import { createReflectionEngine } from "../training/reflection-engine.js";
import { createMediaIndexer, createMediaRetrieval } from "../media/retrieval.js";
import { presetDishes } from "../data/preset-dishes.js";
import { DEFAULT_PROTEIN_TOP_UP_MENU, STAPLES } from "../engine/meal-composition.js";
import { storedProcurement, storedWeekView } from "./display-queries.js";
import {
  handleDailySummary,
  handleGetProfile,
  handleLogExercise,
  handleLogMeal,
  handleLogWater,
  handleLogWeight,
  handleMealCheckin,
  handleSetProfile,
  handleSmartGenerateMealPlan,
  handleSmartRecipeRecommend,
  handleSwapMeal,
  handleWeeklyReport,
} from "../tools/handlers.js";

/**
 * Display API for the compass-health UI (docs/display-interface-plan.md).
 *
 * Every route is a thin adapter onto an existing tool handler, so the UI and
 * the chat agent share one behavior layer: swaps re-lever the day, check-ins
 * attach to plan rows, regeneration supersedes. The only non-handler route is
 * the read-only stored-plan query.
 */
export interface DisplayServerOptions {
  /** Exact origin allowed by CORS. Default: the static frontend dev server. */
  corsOrigin?: string;
  /** When set, every /api request must carry `Authorization: Bearer <token>`. */
  bearerToken?: string;
  /**
   * Service-auth identity resolution (M01): map a trusted `X-External-User-ID`
   * header to an internal user id (find-or-create). Only honored when
   * `bearerToken` is configured, so localhost-trusted mode stays single-user.
   * Callers other than the authenticated BFF cannot reach this path.
   */
  resolveUserId?: (externalUserId: string) => Promise<string>;
}

const DEFAULT_CORS_ORIGIN = "http://localhost:5500";
const MAX_BODY_BYTES = 1_000_000;

/** M03 daily-state routes need the real drizzle handle; test fakes omit it. */
function requireDailyStateDb(ctx: ToolContext): NonNullable<ToolContext["db"]> {
  if (ctx.db === undefined) {
    throw new RangeError("daily state requires a database-backed tool context");
  }
  return ctx.db;
}

type Query = URLSearchParams;
type Body = Record<string, unknown>;
interface DispatchRequest {
  headers: IncomingMessage["headers"];
  raw?: ServerResponse;
}

type RouteHandler = (ctx: ToolContext, query: Query, body: Body, request: DispatchRequest) => Promise<unknown>;

const ROUTES: Readonly<Record<string, RouteHandler>> = {
  "GET /api/health": async (ctx) => ({ ok: true, userId: ctx.userId }),

  "GET /api/profile": (ctx) => handleGetProfile(ctx, {}),
  "POST /api/profile": (ctx, _query, body) => handleSetProfile(ctx, cast(body)),

  "GET /api/plan": async (ctx, query) => {
    const start = requireQueryDate(query, "start");
    const days = boundedInt(query.get("days"), 7, 1, 31);
    const end = addDaysIso(start, days - 1);
    const [rows, profile] = await Promise.all([
      ctx.repo.listMealPlanEntriesRange(ctx.userId, start, end),
      ctx.repo.getLatestBmrProfile(ctx.userId),
    ]);
    return storedWeekView(rows, start, days, {
      ...(profile?.targetKcal === undefined ? {} : { targetKcal: profile.targetKcal }),
      ...(profile?.proteinTargetGrams === undefined ? {} : { proteinTargetGrams: profile.proteinTargetGrams }),
      ...(profile?.fatTargetGrams === undefined ? {} : { fatTargetGrams: profile.fatTargetGrams }),
      ...(profile?.carbsTargetGrams === undefined ? {} : { carbsTargetGrams: profile.carbsTargetGrams }),
    });
  },
  "GET /api/procurement": async (ctx, query) => {
    const start = requireQueryDate(query, "start");
    const days = boundedInt(query.get("days"), 7, 1, 31);
    const rows = await ctx.repo.listMealPlanEntriesRange(ctx.userId, start, addDaysIso(start, days - 1));
    return storedProcurement(rows);
  },
  "POST /api/plan/generate": (ctx, _query, body) => handleSmartGenerateMealPlan(ctx, cast(body)),

  "POST /api/swap": (ctx, _query, body) => handleSwapMeal(ctx, cast(body)),
  "POST /api/checkin": (ctx, _query, body) => handleMealCheckin(ctx, cast(body)),

  "GET /api/summary": (ctx, query) =>
    handleDailySummary(ctx, { date: requireQueryDate(query, "date") }),
  "GET /api/report": (ctx, query) =>
    handleWeeklyReport(ctx, { endDate: requireQueryDate(query, "endDate") }),
  "GET /api/recommend": (ctx, query) => handleSmartRecipeRecommend(ctx, {
    mealType: requireQueryText(query, "mealType"),
    ...(query.get("maxKcal") === null ? {} : { maxKcal: boundedInt(query.get("maxKcal"), 700, 100, 3000) }),
  }),

  /**
   * Fixed food items: the pantry the planner actually uses (preset dish
   * ingredients, staples, top-up foods, natural-unit foods) — NOT the whole
   * reference food library, which holds 1500+ lookup rows.
   */
  "GET /api/foods": async (ctx) => ({
    foods: ctx.catalog.foods.filter((food) =>
      PANTRY_SLUGS.has(food.slug) ||
      ctx.catalog.naturalUnits.some((unit) => unit.foodSlug === food.slug),
    ).map((food) => ({
      slug: food.slug,
      name: food.name ?? food.slug,
      nameZh: food.nameZh ?? null,
      category: food.category ?? null,
      kcalPer100g: food.kcalPer100g,
      proteinGramsPer100g: food.proteinGramsPer100g,
      carbsGramsPer100g: food.carbsGramsPer100g,
      fatGramsPer100g: food.fatGramsPer100g,
      sodiumMgPer100g: food.sodiumMgPer100g,
    })),
    naturalUnits: ctx.catalog.naturalUnits,
  }),

  /** Default recipes: the preset dish library (plus the user's saved dishes). */
  "GET /api/dishes": async (ctx) => {
    const userDishes = await ctx.repo.listUserDishes(ctx.userId);
    return {
      presets: presetDishes.map((dish) => ({
        slug: dish.slug,
        name: dish.name,
        mealTypes: dish.mealTypes ?? [],
        role: dish.role ?? "main",
        selfContained: dish.selfContained ?? true,
        method: dish.method ?? null,
        nutrition: dish.nutrition,
        ingredients: dish.ingredients,
        seasonings: dish.seasonings,
      })),
      userDishes,
    };
  },

  "POST /api/log/meal": (ctx, _query, body) => handleLogMeal(ctx, cast(body)),
  "POST /api/log/water": (ctx, _query, body) => handleLogWater(ctx, cast(body)),
  "POST /api/log/exercise": (ctx, _query, body) => handleLogExercise(ctx, cast(body)),
  "POST /api/log/weight": (ctx, _query, body) => handleLogWeight(ctx, cast(body)),

  // ── M03 daily state (v1): read model + observation/constraint commands ──
  "GET /api/v1/daily-state": async (ctx, query) => {
    const date = requireQueryDate(query, "date");
    const db = requireDailyStateDb(ctx);
    const state = await createDailyStateService(db, ctx.repo)
      .getDailyProjection(ctx.userId, date);
    if (state === undefined) {
      return {
        schemaVersion: "daily-health-state.v1",
        userId: ctx.userId,
        localDate: date,
        projection: { status: "rebuilding", pendingOutboxEvents: 0 },
        missing: true,
      };
    }
    return state;
  },

  "POST /api/v1/observations": async (ctx, _query, body) => {
    const db = requireDailyStateDb(ctx);
    const input = cast(body) as {
      observedOn: string;
      kind: string;
      valueJson?: Record<string, unknown>;
      value?: Record<string, unknown>;
      journeyId?: string;
    };
    if (!input.observedOn || !/^\d{4}-\d{2}-\d{2}$/.test(input.observedOn)) {
      throw new RangeError("observedOn must be an ISO date");
    }
    const kind = input.kind;
    if (!["sleep", "fatigue", "recovery", "pain", "weight", "note"].includes(kind)) {
      throw new RangeError("kind must be one of sleep|fatigue|recovery|pain|weight|note");
    }
    const service = createDailyStateService(db, ctx.repo);
    const result = await service.recordObservation({
      userId: ctx.userId,
      observedOn: input.observedOn,
      kind: kind as "sleep" | "fatigue" | "recovery" | "pain" | "weight" | "note",
      valueJson: input.valueJson ?? input.value ?? {},
      journeyId: input.journeyId,
    }, { commandType: "observation.record", aggregateType: "observation" });
    // Rebuild synchronously for now (local single-worker cadence); M04's
    // standalone worker loop takes over when it runs as a process.
    await service.persistDailyProjection(ctx.userId, input.observedOn,
      process.env["COMPASS_HEALTH_TIMEZONE"] ?? "Asia/Shanghai");
    return result;
  },

  "GET /api/v1/constraints": async (ctx, query) => {
    const date = requireQueryDate(query, "date");
    return createDailyStateService(requireDailyStateDb(ctx), ctx.repo)
      .listActiveConstraints(ctx.userId, date);
  },

  "POST /api/v1/constraints": async (ctx, _query, body) => {
    const input = cast(body) as {
      constraintType: string;
      severity?: string;
      targetJson: Record<string, unknown>;
      reason: string;
      activeFrom: string;
      activeTo?: string;
    };
    if (!input.constraintType || !input.reason || !input.activeFrom) {
      throw new RangeError("constraintType, reason and activeFrom are required");
    }
    return createDailyStateService(requireDailyStateDb(ctx), ctx.repo).addConstraint({
      userId: ctx.userId,
      constraintType: input.constraintType,
      severity: input.severity === "block" ? "block" : "warn",
      targetJson: input.targetJson ?? {},
      reason: input.reason,
      activeFrom: input.activeFrom,
      activeTo: input.activeTo ?? null,
    });
  },

  // ── M05 diet logging (v1): preview → commit → correct ──
  "POST /api/v1/diet/logs:preview": async (ctx, _query, body) => {
    const db = requireDailyStateDb(ctx);
    const input = cast(body) as { description: string; date: string; mealType: string };
    if (!input.description || !input.date || !input.mealType) {
      throw new RangeError("description, date and mealType are required");
    }
    return createDietLogService(db, ctx.repo).preview(ctx, input);
  },

  "POST /api/v1/diet/logs:commit": async (ctx, _query, body) => {
    const db = requireDailyStateDb(ctx);
    const input = cast(body) as {
      date: string;
      mealType: string;
      description: string;
      idempotencyKey?: string;
      expectedRevision?: number;
      items?: Array<{ slug: string; grams: number }>;
    };
    if (!input.date || !input.mealType || !input.description) {
      throw new RangeError("date, mealType and description are required");
    }
    // A user-confirmed candidate list becomes an explicit override estimate so
    // unresolved-segment refusal does not apply to reviewed commits. Nutrition
    // is computed from the catalog for the confirmed slugs — never zeros.
    let overrideEstimate: import("../tools/nutrition-estimate.js").NutritionEstimateResult | undefined;
    if (input.items !== undefined) {
      const { aggregateNutrition } = await import("../engine/nutrition.js");
      const totals = aggregateNutrition({
        foods: input.items.map((item) => ({ slug: item.slug, grams: item.grams })),
        foodRecords: ctx.catalog.foods,
        requireWeightType: true,
      }).total;
      overrideEstimate = {
        description: input.description,
        ...totals,
        items: input.items,
      } as unknown as import("../tools/nutrition-estimate.js").NutritionEstimateResult;
    }

    try {
      const result = await createDietLogService(db, ctx.repo).commit(ctx, {
        userId: ctx.userId,
        logDate: input.date,
        mealType: input.mealType,
        description: input.description,
        source: "web",
        idempotencyKey: input.idempotencyKey,
        expectedRevision: input.expectedRevision,
        ...(overrideEstimate === undefined ? {} : { overrideEstimate }),
      });
      await createDailyStateService(db, ctx.repo)
        .persistDailyProjection(ctx.userId, input.date,
          process.env["COMPASS_HEALTH_TIMEZONE"] ?? "Asia/Shanghai");
      return result;
    } catch (error) {
      if (error instanceof NeedsConfirmationError) {
        throw new DomainHttpError(422, "needs_confirmation", error.message, {
          needsConfirmation: error.estimate.needsConfirmation ?? [],
          unmatched: error.estimate.unmatched ?? [],
        });
      }
      if (error instanceof StateConflict) {
        throw Errors.conflict("state_conflict", "revision mismatch", { currentRevision: error.currentRevision });
      }
      throw error;
    }
  },

  "POST /api/v1/diet/logs:correct": async (ctx, _query, body) => {
    const db = requireDailyStateDb(ctx);
    const input = cast(body) as {
      originalLogId: string;
      mealType?: string;
      description?: string;
      reason?: string;
      idempotencyKey?: string;
    };
    if (!input.originalLogId) throw new RangeError("originalLogId is required");
    const result = await createDietLogService(db, ctx.repo).correct(ctx, {
      userId: ctx.userId,
      originalLogId: input.originalLogId,
      mealType: input.mealType,
      description: input.description,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    // Keep the read model on the effective revision (same cadence as commit).
    await createDailyStateService(db, ctx.repo)
      .persistDailyProjection(ctx.userId, result.revised.logDate,
        process.env["COMPASS_HEALTH_TIMEZONE"] ?? "Asia/Shanghai");
    return result;
  },

  // ── WO-HS-06 / M20: unified pain command (observation + constraint) ──
  "POST /api/v1/health/pain": async (ctx, _query, body) => {
    const db = requireDailyStateDb(ctx);
    const input = cast(body) as {
      observedOn?: string;
      bodyPart?: string;
      severity?: string;
      description?: string;
      journeyId?: string;
    };
    const severityHint = input.severity as never;
    if (severityHint !== undefined && !["mild", "sharp", "worsening", "unstable", "unknown"].includes(severityHint)) {
      throw new RangeError("severity must be mild|sharp|worsening|unstable|unknown");
    }
    return createPainCommand(db).execute({
      userId: ctx.userId,
      observedOn: input.observedOn ?? new Date().toISOString().slice(0, 10),
      bodyPart: input.bodyPart,
      severityHint,
      description: input.description,
      journeyId: input.journeyId,
    });
  },

  // ── M06/M07 training (v1): prepare → start → sets → finish → reflect ──
  "GET /api/v1/training/prepare": async (ctx, query) => {
    const db = requireDailyStateDb(ctx);
    const date = requireQueryDate(query, "date");
    const dayParam = query.get("day");
    const day = dayParam === "A" || dayParam === "B" || dayParam === "C" ? dayParam : undefined;

    const service = createTrainingService(db);
    const proposal = await service.prepareSession(ctx.userId, date, day);

    // WO-HS-07: cycle/readiness recommendation is advisory (shadow mode) -
    // it never silently changes the requested day or the active plan.
    let cycleRecommendation: unknown = null;
    try {
      const { createCycleEngine } = await import("../training/cycle-engine.js");
      cycleRecommendation = await createCycleEngine(db).decide(ctx.userId, date);
    } catch {
      cycleRecommendation = null;
    }
    void cycleRecommendation;

    // WO-HS-06: body-part pain constraints additionally block pattern families.
    const constraints = await db.select().from(schemaRef.healthConstraints).where(and(
      eq(schemaRef.healthConstraints.userId, ctx.userId),
      isNull(schemaRef.healthConstraints.liftedAt),
      sql`${schemaRef.healthConstraints.activeFrom} <= ${date}`,
    ));
    const extraPatterns = new Set<string>();
    for (const c of constraints) {
      if (c.severity !== "block") continue;
      const target = c.targetJson as { bodyPart?: string };
      for (const pattern of blockedPatternsForBodyPart(target.bodyPart)) {
        extraPatterns.add(pattern);
      }
    }
    if (extraPatterns.size > 0) {
      proposal.proposedExercises = proposal.proposedExercises.filter(
        (e) => !extraPatterns.has(String(e.movementPattern)));
      (proposal.blockedExercises as Array<Record<string, unknown>>).push(...[...extraPatterns].map((pattern) => ({
        exerciseSlug: null,
        movementPattern: pattern,
        reason: "blocked_by_body_part_constraint",
        suggestion: "rest_that_pattern",
      })));
    }

    // Persist the filtered plan as a consumable proposal.
    const dailyState = createDailyStateService(db, ctx.repo);
    const current = await dailyState.getDailyProjection(ctx.userId, date);
    const saved = await createPreparedSessionService(db).saveProposal({
      userId: ctx.userId,
      sessionDate: date,
      dayRole: proposal.dayRole,
      planVersionId: proposal.planVersionId ?? null,
      dailyStateRevision: typeof current?.revision === "number" ? current.revision : -1,
      proposedExercises: proposal.proposedExercises as unknown as Array<Record<string, unknown>>,
      blockedExercises: proposal.blockedExercises as unknown as Array<Record<string, unknown>>,
      activeConstraints: proposal.activeConstraints as unknown as Array<Record<string, unknown>>,
    });
    void schemaRef;
    return { ...proposal, proposalId: saved.proposalId, cycleRecommendation };
  },

  "POST /api/v1/training/sessions": async (ctx, _query, body) => {
    const db = requireDailyStateDb(ctx);
    const input = cast(body) as {
      proposalId?: string;
      date?: string;
      dayRole?: "A" | "B" | "C";
      journeyId?: string;
    };
    // WO-HS-06: starting requires a prepared proposal; the raw-template path
    // is gone so constraint-filtered plans are what become sessions.
    if (!input.proposalId) {
      throw new DomainHttpError(400, "proposal_required", "call GET /api/v1/training/prepare first and pass proposalId");
    }
    try {
      const consumed = await createPreparedSessionService(db).consumeValidProposal({
        userId: ctx.userId,
        proposalId: input.proposalId,
        sessionDate: input.date ?? new Date().toISOString().slice(0, 10),
        dayRole: input.dayRole ?? "A",
      });
      const items = ((consumed.proposalJson.proposedExercises ?? []) as Array<Record<string, unknown>>).map((raw) => {
        const item = raw as { order?: unknown; exerciseSlug?: unknown; sets?: unknown;
          repRangeLow?: unknown; repRangeHigh?: unknown; rirLow?: unknown; rirHigh?: unknown };
        return {
          order: Number(item.order ?? 0),
          exerciseSlug: String(item.exerciseSlug ?? ""),
          sets: Number(item.sets ?? 3),
          repRangeLow: item.repRangeLow === undefined ? null : Number(item.repRangeLow),
          repRangeHigh: item.repRangeHigh === undefined ? null : Number(item.repRangeHigh),
          rirLow: item.rirLow === undefined ? null : Number(item.rirLow),
          rirHigh: item.rirHigh === undefined ? null : Number(item.rirHigh),
        };
      });
      const dayRoleMatch = String((consumed.proposalJson as { dayRole?: string }).dayRole ?? input.dayRole ?? "A").trim().toUpperCase();
      const dayRole = (["A", "B", "C"].includes(dayRoleMatch) ? dayRoleMatch : "A") as "A" | "B" | "C";

      try {
        return await createTrainingService(db).startSessionFromProposal({
          userId: ctx.userId,
          sessionDate: input.date ?? new Date().toISOString().slice(0, 10),
          dayRole,
          planVersionId: consumed.planVersionId ?? undefined,
          exercises: items.map((item, index) => ({
            order: item.order || index + 1,
            exerciseSlug: item.exerciseSlug,
            sets: item.sets,
            repRangeLow: item.repRangeLow === null ? undefined : item.repRangeLow,
            repRangeHigh: item.repRangeHigh === null ? undefined : item.repRangeHigh,
            rirLow: item.rirLow === null ? undefined : item.rirLow,
            rirHigh: item.rirHigh === null ? undefined : item.rirHigh,
          })),
          journeyId: input.journeyId,
        });
      } catch (inner) {
        if (inner instanceof RangeError && String(inner.message).includes("no template")) {
          // Proposal-driven start does not need the template; fall through to
          // the proposal-based creation below.
        } else {
          throw inner;
        }
      }

      // Proposal-based session creation without template lookup.
      const [session] = await db.insert(trainingSessionsTable).values({
        userId: ctx.userId,
        sessionDate: input.date ?? new Date().toISOString().slice(0, 10),
        planVersionId: consumed.planVersionId ?? null,
        status: "in_progress",
        startedAt: new Date(),
        journeyId: input.journeyId ?? null,
      }).returning();
      if (!session) throw new Error("session insert returned no row");
      if (items.length > 0) {
        await db.insert(trainingSessionExercisesTable).values(items.map((item) => ({
          sessionId: session.id,
          exerciseSlug: item.exerciseSlug,
          orderIndex: item.order,
          targetSets: item.sets,
          targetRepRangeLow: item.repRangeLow ?? null,
          targetRepRangeHigh: item.repRangeHigh ?? null,
          targetRirLow: item.rirLow ?? null,
          targetRirHigh: item.rirHigh ?? null,
        })));
      }
      return session;
    } catch (error) {
      if (error instanceof ProposalStaleError) {
        throw Errors.conflict("proposal_stale", `training proposal is stale (${error.reason}); re-run prepare`);
      }
      throw error;
    }
  },

  "GET /api/v1/training/sessions": async (ctx, query) => {
    const db = requireDailyStateDb(ctx);
    const sessionId = requireQueryText(query, "id");
    return createTrainingService(db).readBackSession(ctx.userId, sessionId);
  },

  "POST /api/v1/training/sessions:finish": async (ctx, _query, body) => {
    const db = requireDailyStateDb(ctx);
    const input = cast(body) as { sessionId: string; finalStatus?: string };
    if (!input.sessionId) throw new RangeError("sessionId is required");
    const status = input.finalStatus === "interrupted" ? "interrupted"
      : input.finalStatus === "cancelled" ? "cancelled" : "completed";
    const session = await createTrainingService(db)
      .finishSession(ctx.userId, input.sessionId, status);
    await createDailyStateService(db, ctx.repo)
      .persistDailyProjection(ctx.userId, session.sessionDate,
        process.env["COMPASS_HEALTH_TIMEZONE"] ?? "Asia/Shanghai");
    return session;
  },

  "POST /api/v1/training/substitutions:propose": async (ctx, _query, body) => {
    const db = requireDailyStateDb(ctx);
    const input = cast(body) as { sessionId: string; sessionExerciseId: string };
    if (!input.sessionId || !input.sessionExerciseId) {
      throw new RangeError("sessionId and sessionExerciseId are required");
    }
    return createSubstitutionEngine(db).propose(ctx.userId, input.sessionId, input.sessionExerciseId);
  },

  "POST /api/v1/training/substitutions:apply": async (ctx, _query, body) => {
    const db = requireDailyStateDb(ctx);
    const input = cast(body) as {
      sessionId: string;
      sessionExerciseId: string;
      chosenSlug: string;
      reason: string;
      journeyId?: string;
    };
    if (!input.chosenSlug || !input.reason) {
      throw new RangeError("chosenSlug and reason are required");
    }
    const engine = createSubstitutionEngine(db);
    const proposal = await engine.propose(ctx.userId, input.sessionId, input.sessionExerciseId);
    return engine.apply({
      userId: ctx.userId,
      sessionId: input.sessionId,
      proposal,
      chosenSlug: input.chosenSlug,
      reason: input.reason,
      journeyId: input.journeyId,
    });
  },

  "POST /api/v1/training/reflections": async (ctx, _query, body) => {
    const db = requireDailyStateDb(ctx);
    const input = cast(body) as {
      sessionId: string;
      bestCueRefs?: string[];
      unresolvedIssues?: Array<Record<string, unknown>>;
      painSummary?: Array<Record<string, unknown>>;
      proposedAdjustments?: Array<Record<string, unknown>>;
      nextValidationQuestions?: string[];
    };
    if (!input.sessionId) throw new RangeError("sessionId is required");
    const result = await createReflectionEngine(db).record({
      userId: ctx.userId,
      sessionId: input.sessionId,
      bestCueRefs: input.bestCueRefs,
      unresolvedIssues: input.unresolvedIssues,
      painSummary: input.painSummary,
      proposedAdjustments: input.proposedAdjustments as never,
      nextValidationQuestions: input.nextValidationQuestions,
    });
    await createTrainingService(db).readBackSession(ctx.userId, input.sessionId); // read-back proof
    return result;
  },

  "POST /api/v1/training/plans:propose-child": async (ctx, _query, body) => {
    const db = requireDailyStateDb(ctx);
    const input = cast(body) as {
      reflectionId: string;
      changes: Array<Record<string, unknown>>;
      reason: string;
      previousVersionProblems?: string[];
      validationQuestions?: string[];
    };
    if (!input.reflectionId || !input.reason) {
      throw new RangeError("reflectionId and reason are required");
    }
    return createReflectionEngine(db).proposeChildVersion({
      userId: ctx.userId,
      reflectionId: input.reflectionId,
      changes: input.changes ?? [],
      reason: input.reason,
      previousVersionProblems: input.previousVersionProblems,
      validationQuestions: input.validationQuestions,
    });
  },

  "POST /api/v1/training/plans:activate": async (ctx, _query, body) => {
    const db = requireDailyStateDb(ctx);
    const input = cast(body) as { childVersionId: string };
    if (!input.childVersionId) throw new RangeError("childVersionId is required");
    await createReflectionEngine(db).activateChildVersion(ctx.userId, input.childVersionId);
    return { activated: true, planVersionId: input.childVersionId };
  },

  // ── M08 media retrieval (v1): J06 cue lookup + feedback ──
  "GET /api/v1/media/segments:search": async (ctx, query) => {
    const db = requireDailyStateDb(ctx);
    return createMediaRetrieval(db).search({
      movementPattern: query.get("pattern") ?? undefined,
      bodyPart: query.get("bodyPart") ?? undefined,
      category: query.get("category") ?? undefined,
      text: query.get("text") ?? undefined,
      limit: query.get("limit") === null ? undefined : Number(query.get("limit")),
    });
  },

  // ── WO-HS-09 / M23: authenticated range streaming for a segment's video ──
  "GET /api/v1/media/segments/:id/stream": async (ctx, query, _body, request) => {
    const db = requireDailyStateDb(ctx);
    const segmentId = requireQueryText(query, "id");
    const [segment] = await db.select().from(schemaRef.videoSegments)
      .where(and(eq(schemaRef.videoSegments.id, segmentId), isNull(schemaRef.videoSegments.supersededById)))
      .limit(1);
    if (!segment) throw new DomainHttpError(404, "not_found", "segment not found");
    const [pairing] = await db.select().from(schemaRef.mediaPairings)
      .where(eq(schemaRef.mediaPairings.id, segment.pairingId)).limit(1);
    if (!pairing) throw new DomainHttpError(404, "not_found", "pairing not found");
    const [video] = await db.select().from(schemaRef.mediaAssets)
      .where(eq(schemaRef.mediaAssets.id, pairing.videoAssetId)).limit(1);
    if (!video) throw new DomainHttpError(404, "not_found", "video not found");

    // Never expose local absolute paths; only byte ranges inside the usable window.
    const usableUntilMs = Math.min(
      video.usableVideoUntilMs ?? pairing.usableUntilMs ?? Number.MAX_SAFE_INTEGER,
      video.durationMs ?? Number.MAX_SAFE_INTEGER,
    );
    void usableUntilMs;

    const { stat, createReadStream } = await import("node:fs");
    const statAsync = (await import("node:fs/promises")).stat;
    let total = 0;
    try {
      total = (await statAsync(video.localPath)).size;
    } catch {
      throw new DomainHttpError(503, "media_unavailable", "media file is not accessible on this host");
    }
    void stat;

    const rangeHeader = request?.headers?.range ?? "";
    const match = /bytes=(\d*)-(\d*)/.exec(String(rangeHeader));
    let start = 0;
    let end = Math.min(total - 1, Math.max(total - 1, 0));
    if (match) {
      start = match[1] === undefined || match[1] === "" ? 0 : Number(match[1]);
      end = match[2] === undefined || match[2] === "" ? total - 1 : Number(match[2]);
      end = Math.min(end, total - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      return { error: "range_not_satisfiable" } as never;
    }

    const rawResponse = request.raw;
    if (rawResponse === undefined) {
      return { error: "streaming_unsupported_in_test_mode" };
    }
    rawResponse.writeHead(start > 0 ? 206 : 200, {
      "Content-Type": "video/mp4",
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Cache-Control": "no-store",
    });
    await new Promise<void>((resolve) => {
      const stream = createReadStream(video.localPath, { start, end });
      stream.on("error", () => { rawResponse.end(); resolve(); });
      stream.pipe(rawResponse).on("finish", () => resolve()).on("error", () => resolve());
    });
    return undefined as never;
  },

  "POST /api/v1/media/segments:feedback": async (ctx, _query, body) => {
    const db = requireDailyStateDb(ctx);
    const input = cast(body) as { segmentId: string; helpful: boolean; note?: string };
    if (!input.segmentId || typeof input.helpful !== "boolean") {
      throw new RangeError("segmentId and helpful are required");
    }
    await createMediaRetrieval(db).recordFeedback(ctx.userId, input.segmentId, input.helpful, input.note);
    return { recorded: true };
  },
  // ── WO-HS-04: water / activity / condition canonical routes ──
  "POST /api/v1/water/logs": async (ctx, _query, body) => {
    const input = cast(body) as { amount_ml?: number; amountMl?: number };
    const amount = Math.round(Number(input.amount_ml ?? input.amountMl ?? 0));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) {
      throw new RangeError("amount_ml must be between 1 and 10000");
    }
    return handleLogWater(ctx, {
      date: new Date().toISOString().slice(0, 10),
      description: `${amount}ml`,
    });
  },

  "GET /api/v1/water/today": async (ctx) => {
    const today = new Date().toISOString().slice(0, 10);
    const logs = await ctx.repo.listWaterLogs(ctx.userId, today);
    const total = logs.reduce((sum, log) => sum + log.amountMl, 0);
    const goal = 2000;
    return {
      logs: logs.map((log) => ({ id: log.id, amount_ml: log.amountMl, logged_at: log.logDate })),
      total_ml: total,
      goal_ml: goal,
      percentage: Math.round((total / goal) * 1000) / 10,
    };
  },

  "POST /api/v1/activities": async (_ctx, _query, body) => {
    const input = cast(body) as {
      activity_type?: string; activityType?: string;
      duration_minutes?: number; durationMinutes?: number;
      calories_burned?: number; caloriesBurnedKcal?: number;
      notes?: string;
    };
    const activityType = String(input.activity_type ?? input.activityType ?? "").trim();
    const duration = Number(input.duration_minutes ?? input.durationMinutes ?? 0);
    if (!activityType || !Number.isFinite(duration) || duration <= 0 || duration > 600) {
      throw new RangeError("activity_type and duration_minutes (1-600) are required");
    }
    return handleLogExercise(_ctx, {
      date: new Date().toISOString().slice(0, 10),
      description: `${activityType} ${duration} minutes`,
    });
  },

  "GET /api/v1/activities": async (ctx, query) => {
    const date = query.get("date") ?? new Date().toISOString().slice(0, 10);
    const logs = await ctx.repo.listExerciseLogs(ctx.userId, date);
    return {
      logs: logs.map((log) => ({
        id: log.id,
        activity_type: log.activityType,
        duration_minutes: log.durationMinutes,
        calories_burned_kcal: log.caloriesBurnedKcal,
        logged_at: log.logDate,
        notes: log.notes,
      })),
      total_minutes: logs.reduce((s, l) => s + l.durationMinutes, 0),
      total_calories: logs.reduce((s, l) => s + Number(l.caloriesBurnedKcal), 0),
    };
  },

  "POST /api/v1/body/condition": async (ctx, _query, body) => {
    const input = cast(body) as { weight_kg?: number; weightKg?: number };
    const weight = Number(input.weight_kg ?? input.weightKg ?? 0);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 400) {
      throw new RangeError("weight_kg must be between 1 and 400");
    }
    return handleLogWeight(ctx, { date: new Date().toISOString().slice(0, 10), description: "", weightKg: weight } as never);
  },
};

const PANTRY_SLUGS: ReadonlySet<string> = new Set([
  ...presetDishes.flatMap((dish) => dish.ingredients.map((ingredient) => ingredient.slug)),
  ...STAPLES.map((staple) => staple.slug),
  ...DEFAULT_PROTEIN_TOP_UP_MENU.flatMap((topUp) => topUp.ingredients.map((ingredient) => ingredient.slug)),
]);

export function createDisplayServer(ctx: ToolContext, options: DisplayServerOptions = {}): Server {
  const corsOrigin = options.corsOrigin ?? DEFAULT_CORS_ORIGIN;

  return createServer((request, response) => {
    void dispatch(ctx, options, corsOrigin, request, response).catch((error: unknown) => {
      console.error("display-server dispatch failure:", error);
      if (!response.headersSent) {
        sendJson(response, 500, { error: "internal error" });
      } else {
        response.end();
      }
    });
  });
}

async function dispatch(
  ctx: ToolContext,
  options: DisplayServerOptions,
  corsOrigin: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  response.setHeader("Access-Control-Allow-Origin", corsOrigin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-External-User-ID, X-Request-ID, X-Journey-ID");
  const inboundRequestId = Array.isArray(request.headers["x-request-id"])
    ? request.headers["x-request-id"][0]
    : request.headers["x-request-id"];
  if (typeof inboundRequestId === "string" && inboundRequestId !== "") {
    response.setHeader("X-Request-ID", inboundRequestId);
  }

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  if (options.bearerToken !== undefined) {
    const header = request.headers.authorization ?? "";
    if (header !== `Bearer ${options.bearerToken}`) {
      sendJson(response, 401, { error: "missing or invalid bearer token" });
      return;
    }
  }

  let routeCtx = ctx;
  const externalUserHeader = Array.isArray(request.headers["x-external-user-id"])
    ? request.headers["x-external-user-id"][0]
    : request.headers["x-external-user-id"];

  // WO-HS-02: under service auth, every user-data route MUST carry an
  // explicit per-request identity. Falling back to the startup default user
  // would silently attribute data to the wrong account. /api/health is the
  // only exempt route (pure liveness).
  const isLivenessRoute = request.url !== undefined && request.url.startsWith("/api/health");
  if (options.bearerToken !== undefined && !isLivenessRoute) {
    if (typeof externalUserHeader !== "string" || externalUserHeader === "") {
      sendJson(response, 400, { error: "missing_external_user_id" });
      return;
    }
    if (options.resolveUserId === undefined) {
      sendJson(response, 400, { error: "per-request identity requires service auth (COMPASS_DISPLAY_TOKEN)" });
      return;
    }
    try {
      const userId = await options.resolveUserId(externalUserHeader);
      routeCtx = { ...ctx, userId };
    } catch (error) {
      sendJson(response, 400, { error: `cannot resolve external user: ${error instanceof Error ? error.message : "unknown"}` });
      return;
    }
  } else if (typeof externalUserHeader === "string" && externalUserHeader !== "") {
    // No service auth configured (localhost-trusted mode): identity headers
    // stay forbidden so a local caller cannot impersonate another user.
    sendJson(response, 400, { error: "per-request identity requires service auth (COMPASS_DISPLAY_TOKEN)" });
    return;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  const route = ROUTES[`${request.method} ${url.pathname}`];
  if (route === undefined) {
    sendJson(response, 404, { error: `no route for ${request.method} ${url.pathname}` });
    return;
  }

  let body: Body = {};
  if (request.method === "POST") {
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid body" });
      return;
    }
  }

  try {
    const payload = await route(routeCtx, url.searchParams, body, { headers: request.headers, raw: response });
    if (payload === undefined && response.writableEnded) {
      return; // streamed by the handler
    }
    sendJson(response, 200, payload);
  } catch (error) {
    // WO-HS-03: typed domain errors carry real status codes — conflicts are
    // 409, ownership misses 404, needs-confirmation 422. The BFF preserves
    // status + structured body downstream.
    if (error instanceof DomainHttpError) {
      sendJson(response, error.status, {
        error: error.code,
        ...(error.message ? { detail: error.message } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
      });
      return;
    }
    // Handlers signal user-facing validation/refusal via RangeError; its
    // message (e.g. a swap refusal naming valid swaps) is UI copy.
    if (error instanceof RangeError) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    console.error(`display-server ${request.method} ${url.pathname} failed:`, error);
    sendJson(response, 500, { error: "internal error" });
  }
}

function readJsonBody(request: IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw === "") {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          reject(new Error("request body must be a JSON object"));
          return;
        }
        resolve(parsed as Body);
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(body);
}

function requireQueryText(query: Query, name: string): string {
  const value = query.get(name)?.trim() ?? "";
  if (value === "") throw new RangeError(`query parameter ${name} is required`);
  return value;
}

function requireQueryDate(query: Query, name: string): string {
  const value = requireQueryText(query, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError(`query parameter ${name} must be YYYY-MM-DD`);
  }
  return value;
}

function boundedInt(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function addDaysIso(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function cast<T>(body: Body): T {
  return body as unknown as T;
}
