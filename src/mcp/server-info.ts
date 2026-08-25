/**
 * P1 / WO-MCP-1: static server identity and protocol metadata.
 *
 * The 2026-07-28 spec removed protocol-level sessions: every request must be
 * self-describing. All cross-call state lives in explicit handles issued by
 * this server (runHandle, trainingProposalId, trainingSessionId, …) and is
 * passed back as ordinary tool arguments — never as a hidden session.
 */

export const MCP_SERVER_NAME = "compass-health";
export const MCP_SERVER_VERSION = "0.1.0";

/**
 * Protocol revisions this server serves. The modern stdio entry selects this
 * revision through `server/discover`; no initialize exchange is used.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2026-07-28"] as const;

/**
 * Cache policies for list/read results (2026-07-28 requires ttlMs +
 * cacheScope on cacheable responses). All scopes are `private`: health data
 * is per-user and must never be shared caches.
 */
export const CACHE_TTL_MS = {
  systemCapabilities: 3_600_000,
  toolCatalog: 3_600_000,
  resourceCatalog: 3_600_000,
  profile: 60_000,
  dailyState: 2_000,
  activeConstraints: 2_000,
  activePlan: 10_000,
  inProgressSession: 1_000,
  confirmedMediaMetadata: 3_600_000,
  agentRunTimeline: 0,
} as const;

/** Everything this server exposes, in one deterministic document. */
export function serverCapabilitiesDocument() {
  return {
    server: {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
      protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
    },
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false },
    },
    deprecated: {
      roots: "not implemented",
      sampling: "not implemented",
      logging: "not implemented",
      httpSse: "removed by 2026-07-28; use streamable HTTP",
    },
    stateModel: {
      sessions: "none — requests are self-contained (2026-07-28)",
      handles: [
        "runHandle",
        "trainingProposalId",
        "trainingSessionId",
        "sessionExerciseId",
        "substitutionProposalId",
        "planVersionId",
        "constraintId",
        "stateRevision",
      ],
    },
  };
}
