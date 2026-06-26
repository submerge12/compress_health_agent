import { describe, expect, test } from "vitest";

import type { MemoryRecordRow } from "../../src/db/repository.js";
import type { ToolContext } from "../../src/tools/context.js";
import { handleRecall, handleRemember } from "../../src/tools/handlers.js";

function memory(overrides: Partial<MemoryRecordRow>): MemoryRecordRow {
  return {
    id: "memory-id",
    userId: "user-id",
    kind: "preference",
    subject: "cilantro",
    content: "User does not eat cilantro.",
    sourceText: null,
    confidence: 1,
    status: "active",
    supersededBy: null,
    validFrom: new Date("2026-06-26T00:00:00.000Z"),
    validTo: null,
    lastConfirmedAt: new Date("2026-06-26T00:00:00.000Z"),
    timesReferenced: 0,
    ...overrides,
  };
}

function makeContext(repo: Partial<ToolContext["repo"]>): ToolContext {
  return {
    userId: "user-id",
    locale: "zh",
    repo: repo as ToolContext["repo"],
    catalog: { foods: [], naturalUnits: [] },
    seasoningRecords: [],
    close: async () => undefined,
  };
}

describe("memory handlers", () => {
  test("handleRemember persists high-confidence durable memory for the current user", async () => {
    const calls: unknown[] = [];
    const ctx = makeContext({
      upsertMemory: async (input) => {
        calls.push(input);
        return memory(input);
      },
    });

    const result = await handleRemember(ctx, {
      kind: "dislike",
      subject: "cilantro",
      content: "User does not eat cilantro.",
      sourceText: "我不吃香菜",
      confidence: 0.9,
    });

    expect(calls).toEqual([
      {
        userId: "user-id",
        kind: "dislike",
        subject: "cilantro",
        content: "User does not eat cilantro.",
        sourceText: "我不吃香菜",
        confidence: 0.9,
      },
    ]);
    expect(result).toEqual({ memory: expect.objectContaining({ kind: "dislike", status: "active" }) });
  });

  test("handleRemember asks for confirmation and does not persist low-confidence memory", async () => {
    const calls: unknown[] = [];
    const ctx = makeContext({
      upsertMemory: async (input) => {
        calls.push(input);
        return memory(input);
      },
    });

    const result = await handleRemember(ctx, {
      kind: "preference",
      subject: "breakfast",
      content: "User may prefer savory breakfast.",
      confidence: 0.4,
    });

    expect(calls).toEqual([]);
    expect(result).toEqual({
      needsConfirmation: {
        kind: "preference",
        subject: "breakfast",
        content: "User may prefer savory breakfast.",
        confidence: 0.4,
      },
    });
  });

  test("handleRecall validates query and passes scoped recall options to the repo", async () => {
    const calls: unknown[] = [];
    const ctx = makeContext({
      recallMemories: async (userId, query, options) => {
        calls.push({ userId, query, options });
        return [memory({ kind: "dislike", subject: "cilantro", content: "不吃香菜" })];
      },
    });

    const result = await handleRecall(ctx, {
      query: "香菜",
      kinds: ["dislike"],
      limit: 3,
    });

    expect(calls).toEqual([
      {
        userId: "user-id",
        query: "香菜",
        options: { kinds: ["dislike"], limit: 3 },
      },
    ]);
    expect(result.memories).toEqual([
      expect.objectContaining({ kind: "dislike", subject: "cilantro" }),
    ]);
  });
});
