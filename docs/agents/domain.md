# Domain Docs

How the engineering skills should consume this repo's domain documentation when
exploring the codebase.

## Before exploring, read these

- `CONTEXT.md` at the repo root.
- `docs/adr/` for ADRs that touch the area about to be changed.

If either location does not exist in a future checkout, proceed silently. The
domain-modeling workflow can create or extend these files when terms or
decisions are resolved.

## File structure

This repo uses a single-context layout:

```text
/
|-- CONTEXT.md
|-- docs/
|   `-- adr/
`-- src/
```

## Use the glossary vocabulary

When output names a domain concept, use the term as defined in `CONTEXT.md`.
This applies to issue titles, refactor proposals, hypotheses, test names, and
review notes.

If the needed concept is missing from the glossary, either the work is drifting
from project language or the glossary has a real gap. Note the gap for
domain-modeling.

## Flag ADR conflicts

If output contradicts an existing ADR, surface the conflict explicitly rather
than silently overriding the decision.
