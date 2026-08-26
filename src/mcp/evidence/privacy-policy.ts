export const SENSITIVE_RETENTION_POLICY = {
  rawAudio: {
    retain: false,
    days: 0,
    rationale: "Audio is transient input and is not persisted by default.",
  },
  rawTranscript: {
    retain: true,
    days: 1,
    encrypted: true,
    rationale: "Short-lived encrypted retention supports correction without building a transcript archive.",
  },
  correctedTranscript: {
    retain: false,
    days: 0,
    persistInEvidence: false,
    canonicalTarget: "structured_health_fact",
  },
  agentObjective: {
    retain: true,
    days: 30,
    encrypted: true,
  },
  agentResponseSummary: {
    retain: true,
    days: 30,
    encrypted: true,
  },
  agentEvidence: {
    containsRawFreeText: false,
    retainsReferencesAndStructure: true,
  },
} as const;

const REDACTED_FIELD_KEYS = new Set([
  "token", "password", "secret", "apikey", "authorization",
  "description", "note", "notes", "reason", "objective", "responsesummary",
  "transcript", "rawtranscript", "correctedtranscript", "feedback",
  "painsummary", "unresolvedissues", "text", "query", "comment", "symptoms",
]);

/**
 * Recursively redact evidence values. Arrays are traversed just like objects;
 * when the array's own field is sensitive (for example painSummary), the
 * entire value becomes a structural marker so no element can leak.
 */
export function redactEvidenceValue(value: unknown, fieldName?: string): unknown {
  if (fieldName !== undefined && REDACTED_FIELD_KEYS.has(normalizeFieldName(fieldName))) {
    return redactionMarker(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactEvidenceValue(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, redactEvidenceValue(child, key)]));
  }
  return value;
}

export function redactEvidenceRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!value) return {};
  return redactEvidenceValue(value) as Record<string, unknown>;
}

function normalizeFieldName(value: string): string {
  return value.replace(/[_-]/g, "").toLowerCase();
}

function redactionMarker(value: unknown): string {
  if (typeof value === "string") return `<redacted:string:length=${value.length}>`;
  if (Array.isArray(value)) return `<redacted:array:items=${value.length}>`;
  if (value !== null && typeof value === "object") {
    return `<redacted:object:keys=${Object.keys(value).length}>`;
  }
  return `<redacted:${typeof value}>`;
}
