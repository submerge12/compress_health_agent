import { describe, expect, test } from "vitest";

import { main, profile, getToolHandler, invokeTool } from "../src/index.js";

describe("index entrypoint", () => {
  test("main returns status message with tool count", () => {
    const result = main();
    expect(result).toContain("compass-health");
    expect(result).toContain(`${profile.tools.length} tools`);
  });

  test("main calls writer", () => {
    const messages: string[] = [];
    main((message: string) => messages.push(message));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("compass-health");
  });

  test("getToolHandler returns handler for registered tools", () => {
    for (const tool of profile.tools) {
      expect(getToolHandler(tool.name)).toBeDefined();
    }
  });

  test("getToolHandler returns undefined for unknown tool", () => {
    expect(getToolHandler("nonexistent_tool")).toBeUndefined();
  });

  test("invokeTool throws for unknown tool", async () => {
    const ctx = {} as Parameters<typeof invokeTool>[0];
    await expect(invokeTool(ctx, "nonexistent_tool", {})).rejects.toThrow("Unknown tool");
  });
});
