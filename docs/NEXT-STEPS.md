# Next steps (compass-health-agent) — pointer only

> ⚠️ **Do not edit the AOH status board.** In the AOH-owned model you only *report*.
> - **Report** by appending one JSON line to **your outbox**: `G:\compass-health-agent\docs\status-report.jsonl`
>   e.g. `{"node":"L2","event":"complete","by":"compass-health-agent","at":"<ISO>","evidence":"eval precision up; pnpm green"}`
> - The **AOH instance** reads outboxes and updates the single board during a manual **sync**:
>   `G:\agent-orchestration-harness\docs\implementation\EXECUTION-DAG.md`. You never edit it.
> - A node is executable only when all its `deps` are ✅ in that board — check there before starting, then
>   append a `start` line to your outbox.

## Your node IDs (deps/status/done-when live in the board)
- **H2b** — Track H watch-item: single `proactiveCheck` path through `handleProactiveCheck`.
- **L2** — D-L2 food matcher. Plan: `docs/l2-l3-retrieval-and-memory-plan.md` (L2.1–L2.4, L2.6).
- **L3** — D-L3 memory bulk. Plan: `docs/l2-l3-retrieval-and-memory-plan.md` (L3.1–L3.4). After L3, rebuild `dist` so pi-harness can do **L3reg**.
- **L25** — L2.5 semantic fallback (food matching). Plan: `docs/l25-l36-embedding-fallback-plan.md` (E1 + E2).
- **L36** — L3.6 embedding recall (memory). Plan: `docs/l25-l36-embedding-fallback-plan.md` (E1 + E3).
