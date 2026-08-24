import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ToolContext } from "../tools/context.js";
import { createDailyStateService } from "../domain/daily-state.js";
import { createDietLogService, NeedsConfirmationError, StateConflict } from "../domain/diet-log-service.js";
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
type RouteHandler = (ctx: ToolContext, query: Query, body: Body) => Promise<unknown>;

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
    // unresolved-segment refusal does not apply to reviewed commits.
    const overrideEstimate = input.items === undefined ? undefined : ({
      description: input.description,
      kcal: 0,
      proteinGrams: 0,
      carbsGrams: 0,
      fatGrams: 0,
      sodiumMg: 0,
      items: input.items,
    } as unknown as import("../tools/nutrition-estimate.js").NutritionEstimateResult);

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
        return sendNeedsConfirmation(error.estimate);
      }
      if (error instanceof StateConflict) {
        return { error: "state_conflict", currentRevision: error.currentRevision };
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
};

/** Shape of the ad-hoc override estimate built from confirmed items. */
function sendNeedsConfirmation(estimate: import("../tools/nutrition-estimate.js").NutritionEstimateResult): {
  status: "needs_confirmation";
  needsConfirmation: import("../tools/nutrition-estimate.js").FoodResolutionDiagnostic[];
  unmatched: import("../tools/nutrition-estimate.js").FoodResolutionDiagnostic[];
} {
  return {
    status: "needs_confirmation",
    needsConfirmation: estimate.needsConfirmation ?? [],
    unmatched: estimate.unmatched ?? [],
  };
}

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
  if (typeof externalUserHeader === "string" && externalUserHeader !== "") {
    if (options.bearerToken === undefined || options.resolveUserId === undefined) {
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
    sendJson(response, 200, await route(routeCtx, url.searchParams, body));
  } catch (error) {
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
