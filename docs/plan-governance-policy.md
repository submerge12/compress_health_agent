# Plan Governance Policy

`plan-governance.v1` is deterministic domain policy. MCP prompts and adapters may explain its result, but they do not decide whether a plan change is safe.

## Proposal identity and concurrency

- A proposal transaction locks the Reflection, then the active assignment, then reads the active parent.
- Version numbers are allocated under that assignment lock and protected by `UNIQUE(user_id, scope, version_number)`.
- The proposal hash covers scope, changes, reason, previous-version problems, and requested validation questions using canonical JSON.
- The same Reflection and hash replay the existing Child. A different hash returns `proposal_conflict` (HTTP-equivalent status 409).

## Exercise replacement

A replacement must keep the training purpose, retain sufficient primary-muscle coverage, and pass movement-pattern, stability-demand, equipment, range-of-motion, active joint, and current blocking pain checks. The compiled Diff records preserved effects, lost effects, volume impact, the reasons the replacement was allowed, and next-session validation.

Exercise-specific `cueRefs`, `alternates`, and `videoRefs` are never inherited. New references must be supplied and independently validated for the replacement.

## Cycle safety and recovery evidence

- Every cycle contains a recovery position.
- A repeating cycle may not exceed three consecutive training positions.
- The same day role or overlapping primary muscles may not occur on adjacent positions, including across the repeat boundary.
- A change is high-frequency when training density rises to at least 75%, or when the maximum training run rises to at least three positions.
- High-frequency Drafts are allowed, but activation requires a 42-day evidence snapshot with at least two recovery-safe completed cycles, two sleep observations averaging at least seven hours, two fatigue observations with no high-fatigue value, no blocking constraint, and completion rate of at least 85%.
- Activation repeats the evidence calculation and separately blocks on the latest low sleep (under 5.5 hours) or high fatigue (level 4 or higher).

## Cue references

A durable cue reference must identify an existing UUID Segment that is confirmed, not superseded, backed by a successfully probed video, decodable within a verified video/subtitle/pairing window, and matched to the target exercise, movement pattern, primary body part, or recorded reflection problem.

## Activation and rollback

Forward activation requires MRTR user confirmation, a full Diff, a deterministic governance review, an immutable rollback target, and validation questions. The domain service rechecks these conditions inside the activation transaction. A direct-parent rollback remains available as the safety path and never mutates either version's content.
