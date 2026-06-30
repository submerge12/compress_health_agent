import { pathToFileURL } from "node:url";

import { createToolContextFromEnv } from "./agent.js";
import { invokeTool } from "./index.js";
import type { ToolContext } from "./tools/context.js";

export interface DevReplInvocation {
  tool: string;
  input: Record<string, unknown>;
}

export type DevReplInvoker = (
  ctx: ToolContext,
  tool: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

export interface DevReplDeps {
  createContext?: () => Promise<ToolContext>;
  invoke?: DevReplInvoker;
  write?: (message: string) => void;
}

export function parseDevReplInput(source: string): DevReplInvocation[] {
  const trimmed = source.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("{")) {
    return [parseJsonEnvelope(trimmed)];
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseCommandLine);
}

export async function runDevRepl(source: string, deps: DevReplDeps = {}): Promise<void> {
  const invocations = parseDevReplInput(source);
  if (invocations.length === 0) {
    throw new Error("Expected a tool invocation on stdin.");
  }

  const createContext = deps.createContext ?? createToolContextFromEnv;
  const invoke = deps.invoke ?? invokeTool;
  const write = deps.write ?? ((message: string) => console.log(message));
  const ctx = await createContext();

  try {
    for (const invocation of invocations) {
      const result = await invoke(ctx, invocation.tool, invocation.input);
      write(JSON.stringify(result, null, 2));
    }
  } finally {
    await ctx.close();
  }
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

function parseCommandLine(line: string): DevReplInvocation {
  const [tool, rest = ""] = splitFirstToken(line);
  if (!tool) {
    throw new Error("Expected a tool name.");
  }

  return {
    tool,
    input: rest.trim() ? parseRecordJson(rest) : {},
  };
}

function parseJsonEnvelope(source: string): DevReplInvocation {
  const record = parseRecordJson(source);
  const toolValue = record["tool"] ?? record["name"];
  if (typeof toolValue !== "string" || !toolValue.trim()) {
    throw new Error("JSON invocation must include a string tool or name.");
  }

  const inputValue = record["args"] ?? record["input"] ?? {};
  if (!isRecord(inputValue)) {
    throw new Error("JSON invocation args/input must be an object.");
  }

  return {
    tool: toolValue,
    input: inputValue,
  };
}

function splitFirstToken(line: string): [string, string] {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(line);
  if (!match) return ["", ""];
  return [match[1] ?? "", match[2] ?? ""];
}

function parseRecordJson(source: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(source);
  if (!isRecord(parsed)) {
    throw new Error("Expected JSON arguments to be an object.");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDirectRun(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

if (isDirectRun()) {
  runDevRepl(await readStdin()).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
