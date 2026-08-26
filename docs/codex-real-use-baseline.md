# Codex real-use baseline

This gate is evidence from the real Codex MCP path, not a synonym for green unit tests. Run it only after the MCP user binding passes `pnpm codex:verify-binding` and Codex discovers the `2026-07-28` server without `initialize`.

## Runtime gate

1. Put the populated `compass_health` entry in `%USERPROFILE%\.codex\config.toml`; use [.codex/config.toml.example](../.codex/config.toml.example) as the shape. Keep the database URL and external user id out of Git.
2. Enable Codex feature `mcp_2026_07_28` and retain the per-server `CODEX_MCP_PROTOCOL_VERSION=2026-07-28` opt-in from the example.
3. Review and back up the target before `pnpm db:migrate`, then run `pnpm build` and `pnpm codex:verify-binding` in the configured `cwd`. Migrations 0021, 0023, and 0024 intentionally update legacy evidence/projection rows; do not apply them to a formal database as part of a wire smoke or without explicit data-migration authorization. Migration 0026 is schema-only and adds effective body-profile fields and lookup indexing. Codex must launch `node dist/mcp/stdio.js` directly; a package-manager wrapper corrupts STDIO with banner text.
4. Restart Codex so it reloads MCP configuration and the project skill.
5. Confirm `server/discover` reports only protocol `2026-07-28`, the formal tool `resultType` schemas, and no session-id requirement.
6. Start a separate run for each journey. Never use synthetic health facts in the bound real user.

`codex:verify-binding` is read-only. It first enforces the same schema startup gate as the MCP process, then returns a binding fingerprint, timezone, locale, profile presence, and history counts. It does not print the external id or health payloads. An outdated schema, unknown user, empty profile, or empty history is not eligible for this gate.

If the formal database is behind `MIN_SCHEMA_VERSION`, stop at the startup gate. Use a separately migrated isolated database for J09 and client compatibility checks; never relabel isolated evidence as J01-J07 real-use evidence.

## Journey gates

| Journey | Real-use condition | Required read-back |
| --- | --- | --- |
| J01 | Read the Profile Resource; when the user supplied changed body data, record its effective-dated version; generate/read diet plan, record an actual meal, resolve a genuinely ambiguous food candidate | Profile and plan receipts, Profile Resource read-back, one meal fact, Daily State plan/actual/deviation, state revision |
| J02 | Prepare and complete a real training session with per-set weight, reps, RIR, muscle feeling, and pain | Session resource with sets, receipt IDs, Daily State |
| J03 | Only when low sleep actually occurs | Updated Daily State and cycle decision; active plan unchanged |
| J04 | Only when knee discomfort actually occurs | Pain observation, active constraint, prepared session without blocked movement |
| J05 | Only during real equipment contention | MRTR-selected substitution, remaining-set lineage, completion at most 100% |
| J06 | Only after a real video import | Signed URL opens, the segment is watched, feedback receipt is read back |
| J07 | Only from a real completed session | Reflection, child draft, full diff, MRTR activation, changed next prepare, rollback |
| J08 | Only after the voice chain exists | Transcript-to-command evidence without retained raw audio by default |
| J09 | Isolated database only | Controlled failure, diagnostics, dead letter, replay/drain, fresh projection, no duplicate fact |

## Evidence record

For every journey, save one redacted record under `evidence/codex-real-use-baseline/`. Do not store raw meal descriptions, symptoms, transcript text, database credentials, request state tokens, or input responses in Git.

```json
{
  "journeyId": "J01",
  "status": "passed | failed | blocked | not_run",
  "runHandle": "uuid",
  "inputSummary": "redacted category only",
  "resourceReads": [{ "uri": "health://...", "stateRevision": "..." }],
  "toolCalls": [{ "tool": "health_...", "resultType": "complete" }],
  "mrtr": [{ "tool": "health_...", "decision": "accepted | modified | rejected" }],
  "factIds": ["uuid"],
  "receiptIds": ["uuid"],
  "outboxIds": ["uuid"],
  "stateRevisions": ["..."],
  "userDecision": "accepted | modified | rejected | not_applicable",
  "failureLayer": "none | codex | mcp | domain | database | projection | media | voice",
  "conclusion": "short redacted result"
}
```

After `health_end_run`, call `health_get_run_evidence` and reconcile its terminal tool attempts/results with the record. A journey passes only when the write receipt and projection/resource read-back agree. A test fixture, Tool Catalog call, or custom wire client may support safety evidence but cannot be labeled a real Codex journey.

## Baseline decision

`READY_FOR_CODEX_BASELINE` is allowed only after J01-J07 have genuine applicable evidence, J08 is either passed after voice readiness or explicitly outside the current gate, J09 passes in isolation, and all MCP wire/conformance/security tests remain green. Until then the correct decision is `NOT_READY_FOR_CODEX_BASELINE`.
