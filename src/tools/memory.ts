import type {
  MemoryKind,
  MemoryRecordRow,
  RecallMemoryOptions,
  UpsertMemoryInput,
} from "../db/repository.js";
import type { ToolContext } from "./context.js";

export interface RememberInput {
  kind: MemoryKind;
  subject: string;
  content: string;
  sourceText?: string;
  confidence?: number;
}

export interface MemoryNeedsConfirmation {
  kind: MemoryKind;
  subject: string;
  content: string;
  sourceText?: string;
  confidence: number;
}

export type RememberResult =
  | { memory: MemoryRecordRow }
  | { needsConfirmation: MemoryNeedsConfirmation };

export interface RecallInput {
  query: string;
  kinds?: MemoryKind[];
  limit?: number;
}

export interface RecallResult {
  memories: MemoryRecordRow[];
}

const MEMORY_KINDS = new Set<MemoryKind>(["preference", "dislike", "routine", "note"]);
const MIN_PERSIST_CONFIDENCE = 0.7;

export async function handleRemember(ctx: ToolContext, input: RememberInput): Promise<RememberResult> {
  const fields = requireInputObject(input, "input");
  const kind = requireMemoryKind(fields.kind);
  const subject = requireText(fields.subject, "subject");
  const content = requireText(fields.content, "content");
  const sourceText = optionalText(fields.sourceText, "sourceText");
  const confidence = optionalConfidence(fields.confidence);

  if (confidence < MIN_PERSIST_CONFIDENCE) {
    return {
      needsConfirmation: {
        kind,
        subject,
        content,
        ...(sourceText !== undefined ? { sourceText } : {}),
        confidence,
      },
    };
  }

  const upsert: UpsertMemoryInput = {
    userId: ctx.userId,
    kind,
    subject,
    content,
    ...(sourceText !== undefined ? { sourceText } : {}),
    confidence,
  };
  return { memory: await ctx.repo.upsertMemory(upsert) };
}

export async function handleRecall(ctx: ToolContext, input: RecallInput): Promise<RecallResult> {
  const fields = requireInputObject(input, "input");
  const query = requireText(fields.query, "query");
  const kinds = optionalKinds(fields.kinds);
  const limit = optionalLimit(fields.limit);
  const options: RecallMemoryOptions = {
    ...(kinds !== undefined ? { kinds } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };

  return {
    memories: await ctx.repo.recallMemories(ctx.userId, query, options),
  };
}

function requireMemoryKind(value: unknown): MemoryKind {
  if (typeof value !== "string" || !MEMORY_KINDS.has(value as MemoryKind)) {
    throw new RangeError("kind must be preference, dislike, routine, or note");
  }
  return value as MemoryKind;
}

function optionalKinds(value: unknown): MemoryKind[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new RangeError("kinds must be an array");
  }
  return value.map(requireMemoryKind);
}

function optionalConfidence(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError("confidence must be a number between 0 and 1");
  }
  return value;
}

function optionalLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError("limit must be a positive number");
  }
  return Math.floor(value);
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireText(value, name);
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new RangeError(`${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new RangeError(`${name} is required`);
  return trimmed;
}

function requireInputObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}
