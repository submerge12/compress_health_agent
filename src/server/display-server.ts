import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ToolContext } from "../tools/context.js";
import type { MealPlanEntryRow } from "../db/repository.js";
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
}

const DEFAULT_CORS_ORIGIN = "http://localhost:5500";
const MAX_BODY_BYTES = 1_000_000;

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
    const rows = await ctx.repo.listMealPlanEntriesRange(ctx.userId, start, end);
    return { startDate: start, endDate: end, days: groupByDate(rows, start, days) };
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

  "POST /api/log/meal": (ctx, _query, body) => handleLogMeal(ctx, cast(body)),
  "POST /api/log/water": (ctx, _query, body) => handleLogWater(ctx, cast(body)),
  "POST /api/log/exercise": (ctx, _query, body) => handleLogExercise(ctx, cast(body)),
  "POST /api/log/weight": (ctx, _query, body) => handleLogWeight(ctx, cast(body)),
};

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
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

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
    sendJson(response, 200, await route(ctx, url.searchParams, body));
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

function groupByDate(
  rows: readonly MealPlanEntryRow[],
  start: string,
  days: number,
): { date: string; entries: MealPlanEntryRow[] }[] {
  return Array.from({ length: days }, (_, index) => {
    const date = addDaysIso(start, index);
    return { date, entries: rows.filter((row) => row.planDate === date) };
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
