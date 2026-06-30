import { describe, expect, test } from "vitest";

import { parseDevReplInput, runDevRepl } from "../src/dev-repl.js";
import type { ToolContext } from "../src/tools/context.js";

describe("dev repl", () => {
  test("parses tool-name plus json arguments", () => {
    expect(parseDevReplInput('daily_summary {"date":"2026-06-30"}')).toEqual([
      {
        tool: "daily_summary",
        input: { date: "2026-06-30" },
      },
    ]);
  });

  test("parses json envelope input", () => {
    expect(parseDevReplInput('{"tool":"recall","args":{"query":"cilantro"}}')).toEqual([
      {
        tool: "recall",
        input: { query: "cilantro" },
      },
    ]);
  });

  test("defaults missing json envelope args to an empty object", () => {
    expect(parseDevReplInput('{"tool":"weekly_report"}')).toEqual([
      {
        tool: "weekly_report",
        input: {},
      },
    ]);
  });

  test("rejects json envelope without a string tool", () => {
    expect(() => parseDevReplInput('{"args":{}}')).toThrow("JSON invocation must include a string tool or name.");
  });

  test("rejects non-object json args", () => {
    expect(() => parseDevReplInput('{"tool":"recall","args":["cilantro"]}')).toThrow(
      "JSON invocation args/input must be an object.",
    );
  });

  test("runs invocations with one context and closes it", async () => {
    const writes: string[] = [];
    let closed = false;
    const ctx = {
      userId: "test-user",
      locale: "zh",
      close: async () => {
        closed = true;
      },
    } as unknown as ToolContext;

    await runDevRepl('daily_summary {"date":"2026-06-30"}', {
      createContext: async () => ctx,
      invoke: async (receivedCtx, tool, input) => ({
        receivedSameContext: receivedCtx === ctx,
        tool,
        input,
      }),
      write: (message) => writes.push(message),
    });

    expect(JSON.parse(writes[0] ?? "")).toEqual({
      receivedSameContext: true,
      tool: "daily_summary",
      input: { date: "2026-06-30" },
    });
    expect(closed).toBe(true);
  });

  test("closes context when invocation throws", async () => {
    let closed = false;
    const ctx = {
      userId: "test-user",
      locale: "zh",
      close: async () => {
        closed = true;
      },
    } as unknown as ToolContext;

    await expect(
      runDevRepl('nope {"x":1}', {
        createContext: async () => ctx,
        invoke: async () => {
          throw new RangeError("Unknown tool: nope");
        },
        write: () => undefined,
      }),
    ).rejects.toThrow("Unknown tool: nope");
    expect(closed).toBe(true);
  });
});
