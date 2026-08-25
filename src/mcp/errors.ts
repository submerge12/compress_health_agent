/**
 * P1: MCP error taxonomy. Domain failures surface as tool-call results with
 * `isError: true` and a machine-readable `code` — the protocol transport
 * itself stays healthy. Only protocol violations (bad version, unknown
 * method, unauthorized actor) become JSON-RPC errors.
 */
export type McpErrorCode =
  | "protocol_version_mismatch"
  | "unauthorized_actor"
  | "missing_external_user_id"
  | "unknown_user_binding"
  | "not_found"
  | "state_conflict"
  | "proposal_stale"
  | "invalid_session_state"
  | "validation_failed"
  | "domain_unavailable"
  | "internal";

export class McpProtocolError extends Error {
  constructor(
    readonly code: McpErrorCode,
    message: string,
    readonly jsonRpcCode?: number,
  ) {
    super(message);
    this.name = "McpProtocolError";
  }
}

/** Standard JSON-RPC error codes used by this server. */
export const JSON_RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

/**
 * Map any domain throw to a stable error payload for tool results.
 * Unknown errors never leak internals — message is generic, details empty.
 */
export function toToolError(error: unknown): { code: McpErrorCode; message: string } {
  if (error instanceof McpProtocolError) {
    return { code: error.code, message: error.message };
  }
  const raw = error as { code?: string; message?: string } | null;
  switch (raw?.code) {
    case "proposal_stale":
    case "state_conflict":
    case "invalid_session_state":
    case "missing_external_user_id":
    case "unknown_user_binding":
      return { code: raw.code as McpErrorCode, message: raw.message ?? raw.code };
    case "not_owned":
      return { code: "not_found", message: "resource not found for this user" };
    default:
      break;
  }
  if (error instanceof RangeError) {
    return { code: "validation_failed", message: error.message };
  }
  return { code: "internal", message: "internal error" };
}
