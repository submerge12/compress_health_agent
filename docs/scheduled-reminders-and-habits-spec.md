# Scheduled Reminders & Habits Spec

**Status:** Design (deferred implementation)
**Scope:** How the agent reminds users to defrost/prep ingredients ahead of cooking, how time-anchored proactive interactions fire, and how meal-time Q&A learns the user's routine.
**Builds on:** classification (P2 — meat/poultry/seafood buckets), L3 memory (`remember`/`recall` with supersession), `meal_checkin`, `proactiveCheck`.

## Philosophy — consult first, never assume

The schedule is the **anchor**; habits **refine** it; **nothing time-anchored fires on an assumed time.**

```
consult (ask once) ─► operational schedule ─► reminders fire against it
       ▲                                              │
       └────── learn (meal-time Q&A) ◄── supersede ───┘
```

The agent asks for the user's routine up front, learns from each meal interaction, and over time asks less. **Hard rule:** a defrost/prep reminder is only emitted when its cook time comes from a *confirmed or learned* schedule — never a default guess. If the schedule is unknown, the agent asks rather than fires.

> This replaces the current behavior, where the thaw reminder rides fixed cron times (8:30/12:30/18:30) — i.e. it *assumes* meal times. That assumption is the flaw this spec removes.

## The defrost-reminder pipeline

A defrost reminder is **time-anchored** and needs five inputs in sequence:

```
schedule: when the user cooks dinner            ← user (consult/learn)   [NEW]
  → plan entry: 红烧带鱼 (contains 带鱼)          ← meal_plan_entries
  → bucket = seafood                              ← classification (EXISTS)
  → durations: defrost 60m + marinate 30m + cook 20m  ← duration data    [NEW]
  → reminderTime = cookTime − (defrost + marinate + cook)
  → enqueue reminder                              ← reminders queue        [NEW]
  → polling tick fires it ~that time              ← dispatcher             [NEW]
```

Only the middle (classification) exists today. The two ends — *when you cook* and *delivering a reminder at an arbitrary time* — are the new work.

## What exists vs. what's new

| Need | Status |
|---|---|
| "Which dishes need thawing" (meat/poultry/seafood) | ✅ classification |
| Habit store with supersession | ✅ L3 memory (kind `routine`) |
| Meal check-in hook | ✅ `meal_checkin` / `proactiveCheck` |
| Structured schedule (wake + per-meal times, weekday/weekend) | ➕ new |
| Clock time + cook time on plan entries | ➕ new |
| Defrost / marinate / prep durations | ➕ new |
| Reminder queue (fire-once, snooze, cancel) | ➕ new |
| Arbitrary-time firing | ➕ new (polling tick; cron is static today) |
| User-timezone correctness | 🐛 fix (`proactiveCheck` uses server `getHours()`, not `ctx.timezone`) |

---

## 1. Schedule model (consult-first)

A **structured** schedule — reminder math needs real times, not free-text.

```ts
// new table: user_meal_schedule  (one row per user per weekday, or a default + exceptions)
interface UserMealSchedule {
  userId: string;
  weekday: number | null;        // 0–6, or null = default
  wakeTime?: string;             // "07:00" local
  breakfastTime?: string;
  lunchTime?: string;
  dinnerTime?: string;
  cookLeadMinutes?: number;      // how long before a meal they start cooking
  cooksFromFrozen?: boolean;     // gates defrost reminders entirely
}
```

- Times may be **left blank** → the field is *learned*, not assumed.
- Soft/explanatory habits ("skips breakfast on weekends", "eats late after the gym") live in **L3 memory** (`kind: routine`), not here. Don't do time arithmetic on memory text.
- A `set_schedule` interaction (or an extension of `set_profile`) captures this; unknown fields trigger a question, not a default.

## 2. Duration data

- **Per-ingredient** `defrost_minutes` on `food_items` (0 for non-frozen / pantry items).
- **Per-dish** `marinate_minutes` + `prep_minutes` (optional; default 0).
- Gated by `cooksFromFrozen` and by whether the user actually freezes that item — **consult-first applies**: don't tell someone to thaw fresh fish.

## 3. Reminder queue + polling dispatcher

```ts
// new table: reminders
interface Reminder {
  id: string;
  userId: string;
  fireAt: string;                // timestamptz (UTC); computed from local schedule × tz
  type: "defrost" | "prep" | "meal_checkin" | "daily_summary";
  payload: Record<string, unknown>;  // dish/meal refs, message key
  status: "pending" | "fired" | "cancelled" | "snoozed";
  dedupeKey: string;             // user+meal+type+date — fire-once
}
```

- **One scheduled task** `reminder_tick` at `intervalMinutes: 10–15`. `proactiveCheck` becomes a **dispatcher**: load `status='pending' AND fireAt ≤ now`, aggregate (multiple due at once → one message), emit, mark `fired`.
- 10–15 min granularity is right for "thaw ~1.5h ahead" — this is **not** a live countdown (those stay client-side, per the earlier timers decision).
- **Dedup / lifecycle:** unique `dedupeKey`; `meal_checkin: skipped` or plan regeneration **cancels** the matching pending reminders; snooze re-stamps `fireAt`.
- Lives entirely within the existing cron model — no new scheduler infra.

## 4. Precompute on plan-generate

When a plan is generated **and** a schedule exists:
- For each upcoming meal whose dish has a `meat|poultry|seafood` bucket (and the user freezes it), compute `fireAt = cookTime − (defrost + marinate + prep)` and enqueue a `defrost`/`prep` reminder.
- Regeneration cancels superseded reminders first (by `dedupeKey`).
- If no schedule yet → enqueue nothing; the agent asks for the schedule instead.

## 5. The learning loop (meal-time Q&A)

Extend the check-in so each meal interaction teaches the schedule:
- `meal_checkin` gains optional fields: `ateAt?`, `wokeAt?` (morning), `timingOk?: boolean`, plus the existing `status`.
- On check-in, write **both**: refine `user_meal_schedule` times (structured) **and** an L3 `routine` memory (soft, with supersession when observed ≠ stated).
- Over time the operational schedule is *learned*, so the agent asks fewer onboarding questions. Supersession resolves "stated 12:00, observed 13:00."

## 6. Consent, cadence, timezone

- **Opt-in + quiet hours** for proactive pings — your "ask first" principle extends to *whether* to remind. Store reminder preferences (per type) in memory or a small settings field.
- **Timezone:** compute `fireAt` from the user's local schedule × `ctx.timezone`; fix `proactiveCheck` to evaluate "now" in the user's tz before any time-anchored reminder ships.

## Open decisions

1. **Schedule granularity:** per-weekday rows vs. a single default + exceptions (v1: default + weekend override?).
2. **Duration source:** seed reasonable defaults per ingredient/method, or ask the user per dish? (Recommend seeded defaults, user-overridable.)
3. **Freezes-from-frozen signal:** global `cooksFromFrozen` vs. per-ingredient — defrost reminders are wrong without it.
4. **Reminder cadence/quiet hours defaults** before opt-in is set.
5. **Whether `meal_checkin` triggers proactively or only on user message** — affects how learning data accrues.

## Testing

- **Deterministic** (unit/integration): `proactiveCheck` already takes an injectable `now` — test reminder-due computation (`fireAt` math across timezones), and the queue lifecycle (enqueue → fire-once → cancel on skip → snooze). Property: a reminder never fires twice (dedupeKey).
- **Schedule learning** (integration, DB): check-in writes refine the schedule and supersede stale habits.
- **Soft** (eval): "was the timing suitable" interpretation — record-and-surface first; judgment later.

## Implementation order (when picked up)

1. **Fix the timezone** in `proactiveCheck` (prerequisite for any time-anchored reminder).
2. **Schedule model** (`user_meal_schedule` + `set_schedule`/onboarding) — consult-first.
3. **Duration data** (food_items `defrost_minutes`; dish `marinate/prep_minutes` + seed defaults).
4. **Reminder queue** + `reminder_tick` dispatcher (refactor `proactiveCheck` to drain the queue).
5. **Precompute** defrost/prep reminders on plan-generate (+ cancel on change/skip).
6. **Learning loop** — extend `meal_checkin` + write schedule/L3 memory.
7. **Consent/quiet-hours** preferences.

## Relationship to other specs
- Uses **classification** (`meal-plan-constraint-spec.md` §0) to know which dishes need thawing.
- Uses **L3 memory** (`l2-l3-retrieval-and-memory-plan.md`) for soft habits + supersession.
- The reminder dispatcher refactors the same `proactiveCheck` that today does meal check-ins + daily summary; those become queue-driven reminder types.
- **Live countdowns are out of scope** (client-side, per the earlier timers discussion) — this spec covers coarse, schedule-anchored reminders only.
