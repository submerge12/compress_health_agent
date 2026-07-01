# Spec: Claude-Code-style TUI for the pi-harness CLI

**Status:** Handoff spec. To be implemented in a **pi-harness** session — NOT in compass-health.
**Why this file lives here:** it was scoped from a compass-health session, where `G:\pi-harness` is
read-only. This is a portable spec to hand to a Claude Code session running *in* pi-harness.

## Goal

Replace the plain `readline` REPL with a full-screen terminal UI that matches Claude Code's feel:

1. A **persistent input box pinned to the bottom** of the terminal.
2. Typing **`/`** opens a **filtered command menu** (arrow-key selectable) of the available slash
   commands.
3. **Rendered markdown** in agent responses (bold, headings, lists, tables) instead of raw `**`.
4. A **scrollback transcript** above the input that streams the response live.

This is a **framework-wide** change: the CLI is shared by every agent (travel, coding,
compass-health, …), so all of them get the new UI. No agent-side change is required.

## Current state (what exists today)

- `src/cli/index.ts` (~389 lines) — arg parsing, the `ReplHarness` adapter, command help
  (`usage` + `commands: /model /cost /cache /sessions /thinking /compact /quit`), `runOneShot()`,
  session/agent listing. Key calls observed: `harness.runRequest({ rawRequest: text })`,
  `harness.prompt(text)`, `harness.getThinkingLevel()`, `harness.setThinkingLevel(level)`.
- `src/cli/repl.ts` — the line loop: `createInterface` (node:readline/promises) +
  `readline.question(options.promptLabel ?? "> ")`. This is what makes it look "plain".
- `src/cli/renderer.ts` (~118 lines) — `class CliRenderer`, `handleEvent(event)`; streams text
  with `this.output.write(delta)` and prints bracketed markers `[tool:start]` / `[tool:end]` /
  `[retry]`; formats cost/usage.
- `src/cli/permission-prompt.ts` — `promptForPermission` via a separate readline
  `question("allow? [y/N/a/d] ")`.

The model output event stream is already centralized (whatever `runOneShot` subscribes to and
feeds into `CliRenderer.handleEvent`). The TUI reuses that exact event source — only the rendering
target changes.

> Confirm the exact harness/event signatures against the live source before coding; the names
> above are observed, not contractual.

## Tech choice

[Ink](https://github.com/vadimdemedes/ink) (React for the terminal) — the same approach Claude
Code uses. It gives a fixed input region + scrolling history out of the box.

Dependencies to add (pi-harness `package.json`):

- `ink` — TUI runtime
- `react` — Ink peer dep
- `ink-text-input` — the bottom input field
- `ink-select-input` — the `/` command menu (or hand-roll with `useInput`)
- `marked` + `marked-terminal` — markdown → ANSI

(Match pi-harness's existing dep style; it's an ESM, Node ≥ 22 project.)

## Target architecture

```
src/cli/
  index.ts            # + choose TUI vs classic; pass through to either
  repl.ts             # UNCHANGED — kept as the fallback path
  renderer.ts         # extract event→view-model mapping (see below)
  tui/
    app.tsx           # <App>: Static history + live region + input + command menu
    use-harness.ts    # hook: subscribe to harness events, expose transcript + send()
    command-menu.tsx   # filtered slash-command list shown when input starts with "/"
    markdown.ts       # finalizeMarkdown(text) -> ANSI via marked-terminal
    permission.tsx    # inline allow?/deny prompt rendered inside the TUI
```

### Layout (`app.tsx`)

- Top: Ink `<Static>` holding **committed** transcript turns (user lines + finalized agent
  messages). `<Static>` renders each item once and lets the terminal scroll naturally — do **not**
  re-render history on every keystroke.
- Middle: a **live region** showing the in-progress streaming agent message (plain text while
  streaming).
- Bottom: the input box (`<ink-text-input>`), always visible. When the buffer starts with `/`,
  render `<CommandMenu>` just above it.

### Streaming + markdown (important ordering)

Streaming partial markdown looks broken (half-open `**`, tables mid-build). So:

1. While a response streams, append deltas to live-region **state** and show them as **plain
   text** (fast, no markdown).
2. On message completion, run the finalized text through `finalizeMarkdown()` (marked-terminal)
   and **push the rendered result into `<Static>`**, clearing the live region.

This gives smooth streaming *and* nicely rendered final output.

### Event wiring (`use-harness.ts` + `renderer.ts`)

`CliRenderer.handleEvent` currently maps harness events → stdout writes. Refactor the
**event→view-model** decision out of `renderer.ts` into a pure function (e.g.
`reduceEvent(state, event)`), then:

- classic mode: `CliRenderer` consumes it and writes to stdout (unchanged behavior).
- TUI mode: `use-harness` consumes the same reducer and drives React state.

Map: text deltas → live region; `tool:start`/`tool:end` → a subtle status line (e.g.
`⚙ propose_dish…` / `✓`); `retry` → a transient notice; usage/cost → footer.

### Command menu (`command-menu.tsx`)

Source the list from the **same place** `formatCliHelp()` uses (`/model /cost /cache /sessions
/thinking /compact /quit`) — don't hardcode a second copy; export a `SLASH_COMMANDS` array from
`index.ts` (or a new `commands.ts`) and consume it in both help text and the menu. Behavior:

- Appears when the input buffer matches `/^\/\w*$/`.
- Filters by the typed prefix; ↑/↓ to move, Enter/Tab to complete, Esc to dismiss.
- Show each command's one-line description.

### Permission prompt (`permission.tsx`)

Replace the separate `readline.question("allow? …")` with an inline TUI prompt: pause input,
render the request + `[y] allow  [n] deny  [a] always  [d] deny-always`, capture one key via
`useInput`, resolve the existing permission callback. Reuse `createStoredPermissionCallback`'s
storage so "always/deny-always" still persist.

## Fallback / opt-out (required)

The TUI needs a raw-mode TTY. Do not break non-interactive use:

- If `process.stdin.isTTY` is false (piped/`runOneShot`/CI) → use the **classic** `repl.ts` /
  one-shot path. No Ink.
- Add a `--classic` flag (and/or `PI_HARNESS_TUI=0`) to force the old REPL even on a TTY.
- Default on an interactive TTY: TUI.

Wire this choice in `index.ts` where it currently calls into `repl.ts`.

## Edge cases to handle

- **Ctrl+C / Ctrl+D** — exit cleanly, call Ink `exit()`, run the harness disposer.
- **Terminal resize** — Ink handles reflow; keep history in `<Static>` so it doesn't repaint.
- **Very long output** — rely on terminal scrollback (that's why history is `<Static>`); don't
  buffer the whole transcript in the live region.
- **Slash commands vs. message** — only treat a leading `/<word>` with no spaces as a command;
  anything else is a normal message (so users can type "/" in prose).
- **Windows / PowerShell** — this is the actual target env; verify raw-mode input, arrow keys, and
  marked-terminal ANSI render correctly in Windows Terminal.

## Testing

- Unit: `reduceEvent` (event → state), `finalizeMarkdown` (markdown → ANSI snapshot), command-menu
  filtering.
- Component: render `<App>` with `ink-testing-library`; assert the input box renders, `/` opens
  the menu, selecting completes the buffer, a streamed message commits to history as rendered
  markdown.
- Regression: piping stdin (non-TTY) still routes to classic/one-shot.
- Keep pi-harness's gate green: `npm run typecheck && npm test && npm run build`.

## Acceptance criteria

1. Launching `node dist/cli/index.js --agent <name>` on an interactive terminal shows a bottom
   input box with scrollback above.
2. Typing `/` shows a filtered, arrow-navigable command menu; selecting runs that command.
3. Agent responses render markdown (bold/headings/lists/tables), not raw `**`.
4. Responses stream live, then settle into rendered markdown.
5. Permission requests are handled inline in the TUI.
6. `--classic` and non-TTY input both still work via the old readline path.
7. typecheck + tests + build pass.

## Boundary note

Implement entirely within `G:\pi-harness`. No compass-health change is needed or allowed for this
feature — it's framework-level. After it ships, every agent (including compass-health) gets the new
UI automatically with no rebuild of this repo.
