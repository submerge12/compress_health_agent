# Codex real-use baseline status

Recorded on 2026-08-26 against branch `fix/health-system-hardening`.

| Journey | Status | Evidence |
| --- | --- | --- |
| J01 | NOT_RUN | Real meal input is required; no formal user health write was authorized for this repair task. |
| J02 | NOT_RUN | A real training session is required. |
| J03 | NOT_APPLICABLE_YET | Run only after real low sleep. |
| J04 | NOT_APPLICABLE_YET | Run only after real knee discomfort. |
| J05 | NOT_APPLICABLE_YET | Run only during real equipment contention. |
| J06 | BLOCKED | Real media import and viewing are required. |
| J07 | BLOCKED | Requires a real completed training session. |
| J08 | BLOCKED | Voice chain is outside the current implementation group. |
| J09 | PASSED_ACTUAL_CODEX_ISOLATED | Actual Codex 0.150.0-alpha.8 observed one controlled dead letter, replayed it to fresh revision 1, and database invariants proved no duplicate fact. See `J09-2026-08-26.json`. |

Current decision: `NOT_READY_FOR_CODEX_BASELINE`.

The repository contains the project skill, configuration template, read-only binding verifier, and evidence format needed for a restarted Codex task to run these journeys safely. Actual Codex discovery/call smoke evidence is in `codex-client-smoke-2026-08-26.json`. J01-J07 still require genuine conditions and formal-write authorization, so the overall decision remains `NOT_READY_FOR_CODEX_BASELINE`.
