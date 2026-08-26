---
name: compass-health
description: Use the Compass Health MCP for J01-J09 health journeys, including MRTR confirmation, receipts, projections, training, diet, and media. Apply when Codex is asked to read or record Compass Health data; do not use it for medical diagnosis.
---

# Compass Health

Use only the discovered `compass_health` MCP tools and `health://` resources. If the server is unavailable, does not discover protocol `2026-07-28`, or returns a binding error, stop and report that infrastructure failure. Do not fall back to direct PostgreSQL access, old HTTP/BFF health writes, or SQLite.

## Journey boundary

1. Start each user journey with `health_begin_run`. Use its `runHandle` for every tool call and resource read in that journey.
2. Keep the objective short and redacted. Do not copy free-form symptoms, meals, or private conversation into the run objective.
3. Use a stable, operation-specific idempotency key. A retry must keep the same run handle, tool, target, arguments, and idempotency key.
4. End the journey with `health_end_run`, including failures or user cancellation. Use the tool's formal outcome (`completed`, `failed`, or `abandoned`) and preserve refusal, cancellation, or blocking only in the redacted summary and acceptance signal.

Never invent a health fact to complete a journey. J03 runs only after real low sleep, J04 only after real knee discomfort, J05 only after real equipment contention, J06 only after a real media import, J07 only from a real completed training session, J08 only after the voice chain exists, and J09 only in an isolated database.

## Reads and writes

- Before preparing or changing training, read the Daily State and active Constraints for the relevant date. Read the active plan or current cycle when the operation depends on it.
- Treat a proposal as unexecuted until the corresponding apply or activation call returns `resultType=complete`. Say "proposed" and "applied" separately.
- A write is successful only when the result is `complete` and includes its receipt and affected identifiers. Read back the relevant projection or resource, and record its state revision. Do not infer success from a conversational response.
- If a write returns `input_required`, no choice has been applied. Show the offered choices to the user and wait. Retry the original tool with unchanged arguments plus the returned `requestState` and keyed `inputResponses`. Never substitute a different target, run, or idempotency key.
- If the user changes the requested operation after `input_required`, abandon that pending request and make a new call with a new idempotency key.
- Use `health_get_run_evidence` for the completed run. Report only redacted evidence and identifiers; do not expose encrypted sensitive payloads or raw health text.

## Safety and truthfulness

Respect domain constraints and block results. Do not diagnose disease, move health rules into the prompt, silently overwrite an active plan, or claim that lagging/failed projection data is fresh. Ask the user before any MRTR choice or other consequential confirmation.

For the evidence fields and journey-specific completion gates, follow [the real-use baseline](../../../docs/codex-real-use-baseline.md).
