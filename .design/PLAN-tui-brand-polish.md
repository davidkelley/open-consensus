# PLAN — tui-brand-polish

## Goal

Make the `@open-consensus/tui` (ink/React slash-command TUI) look like a polished product: a
yellow/mustard brand color, deliberate typographic hierarchy (bold headings, dim secondary text,
semantic status colors), a branded startup banner, and styled command output. **Critically**, ship
a self-contained snapshot harness so an AI agent (and any developer) can _see_ the rendered TUI —
real colors, bold, layout — as a PNG, making every UI change visually verifiable.

## How "seeing the TUI" works (de-risked before planning)

Proven end-to-end with the tools already on this machine (no shipped-bundle deps added):

`ink components → ANSI frame (ink-testing-library, FORCE_COLOR=3 → truecolor 38;2;r;g;b) → ansiToSvg
(our pure converter) → rsvg-convert → PNG → read the image`.

- `ink-testing-library`'s `lastFrame()` preserves ANSI when `FORCE_COLOR=3` is set (verified: mustard
  renders as `[1m[38;2;215;161;74m…`).
- A small SGR parser → SVG (dark bg rect + colored monospace text runs) renders faithfully.
- `rsvg-convert` (installed via `brew install librsvg`) does fontconfig glyph fallback, so box-drawing
  (╭─│╯) **and** status marks (✓ ✗ ◐ ⌛ ∅ ⊘ ⚠) render correctly. ImageMagick `magick` is the fallback
  (renders box-drawing + color but drops some symbol glyphs — acceptable degraded mode).

## Assumptions

- Dark terminal background is the common case; the mustard hex is chosen to read on dark themes.
  chalk downsamples the hex for low-color terminals automatically (no manual 256/16 fallback table).
- `rsvg-convert` / `magick` are **developer-only** tools for the snapshot harness; they are NOT
  required to run the TUI and are NOT added to any package's dependencies. The harness degrades
  gracefully (writes `.txt` + `.svg` always; `.png` only if a renderer is on PATH).
- The snapshot harness is dev/test tooling: pure logic lives under `src/` (coverage-gated, tested
  to the ≥90% line+branch gate); the thin file-writing/`spawn` runner lives OUTSIDE `src/` (in
  `packages/tui/scripts/`) so it is neither bundled by tsup nor counted by the coverage `include`.
- Nothing in `command-core`, the engine, daemon, adapters, or consensus logic changes. This is a
  presentation-only change confined to `packages/tui` (+ a one-line version pass-through in the CLI
  launcher for the banner).
- ink `<Text>` cannot reliably render raw embedded ANSI in a single string; styled output requires
  structured segments. The committed scrollback (`<Static>`) therefore moves from `text: string` to a
  small `Segment[]` model to allow color in history (Stage 3).
- The single-sink redaction invariant (every line reaching the terminal is redacted at exactly one
  `print` chokepoint) MUST be preserved: when `print` accepts segments, redaction runs per-segment
  text at that same sink.
- ink 7 + React 19, Node ≥22 (already the project baseline). The truecolor `FORCE_COLOR=3` capture is
  used only by the dev snapshot script, never at runtime.

## Non-goals

- No new RUNTIME dependencies in the shipped TUI bundle (no spinner libs, no chalk-string libs, no
  ANSI-parse libs). The SGR→SVG converter is a tiny, fully-tested internal module.
- No user-configurable themes / no light-vs-dark auto-detection / no `NO_COLOR` config UI. One tasteful
  built-in theme. (ink already honors the `NO_COLOR` env via chalk; we don't add config surface.)
- No changes to command behavior, parsing, SSE, cancellation, or the timeline reducer's STATE. Only
  how the timeline is RENDERED (a structured renderer is added alongside the existing string renderer).
- No mouse support, no scroll regions, no alternate-screen takeover, no animation beyond a simple
  existing-style busy indicator.
- The snapshot harness is not wired into CI (it needs a renderer + writes artifacts); it is a local
  dev/agent tool. The pure converter IS unit-tested in the normal suite.

## Decisions made (reviewers: push back if wrong)

1. **Brand mustard = `#d7a14a`** (warm mustard; verified legible on dark). Tints: `brandDim`/muted
   `#9c7b3f` for secondary brand text, `brandBright` `#e8b75c` for emphasis. Final values confirmed
   visually during Stage 2 via the harness.
2. **Snapshot SGR→SVG converter is hand-rolled (≈80–120 LOC), not a library.** It handles exactly the
   codes ink/chalk emit (0,1,2,3,4,7,22,23,24,27,39,49, 30–37/90–97, 40–47/100–107, 38/48;5;n,
   38/48;2;r;g;b). Rationale: avoids a new dependency for a dev-only tool, is fully unit-testable, and
   the user prefers lean Node-built-in solutions over pulling frameworks. (Tension with "prefer
   battle-tested libs" acknowledged; the surface is tiny and deterministic.)
3. **`rsvg-convert` preferred, `magick` fallback, neither required.** The runner probes PATH; if
   neither exists it still writes `.txt`/`.svg` and prints a one-line notice. librsvg was installed
   locally to make symbol glyphs render for the agent.
4. **Banner is rendered as styled lines committed to `<Static>` at startup** (replacing the single
   GREETING string), so it scrolls away like Claude Code's banner rather than pinning. No full border
   box (Static is line-oriented); a brand wordmark + dim rule + tagline + version/cwd + hint line. A
   bordered box can be added later if reviewers insist; lines keep it lean and reuse the Stage-3 model.
   The banner lines are seeded via a **lazy `useState` initializer** (`useState(() => bannerLines(...))`),
   NOT a mount `useEffect` — this guarantees exactly-once emission and sidesteps React 19 StrictMode's
   double-invoke of effects (Gemini finding, round 1).
5. **Committed scrollback becomes `Segment[]`-based** (Stage 3). `print(text: string)` keeps working
   (wraps to one default segment, redacted); a `printSegments(Segment[])` path enables color. This is
   the minimum needed for colored history; redaction stays at the one sink.
6. **Timeline gets a structured renderer** `timelineRows(t): Segment[][]` in addition to the existing
   `timelineLines(t): string[]`. Live region (Stage 2) and committed handoff (Stage 4) both use it, so
   running AND finished runs are colored identically. The plain string renderer is retained (tests /
   any text-only need).
7. **Status marks kept** (`· ◐ ✓ ✗ ⌛ ∅ ⊘ ⚠`) but colored semantically (ok=green, refusal/error=red,
   running=mustard, timeout=amber, pending/unavailable=dim, cancelled/interrupted=amber/dim). Verified
   to render via rsvg-convert.

## Stages

### Stage 1 — Snapshot harness ("the AI can see the TUI")

Build the verification tooling first; every later stage is checked by regenerating PNGs and reading
them. Renders the CURRENT (pre-restyle) components to establish a baseline.

Files:
- `packages/tui/src/snapshot/ansiToSvg.ts` (new) — pure `ansiFrameToSvg(frame, opts?) → string`:
  SGR-subset parser → per-row styled runs → SVG (bg rect + `<text>` runs; bold/dim/italic/underline,
  fg/bg, inverse=swap). XML-escapes text. Deterministic; no IO.
- `packages/tui/src/snapshot/scenes.tsx` (new) — `scenes: { name; node: ReactElement }[]` built from
  the real components + inline fixtures (a prompt, an autocomplete state, a running timeline, a
  finished timeline, a transcript sample). Pure (returns elements; no IO, no ink-testing-library).
- `packages/tui/src/snapshot/ansiToSvg.test.ts`, `packages/tui/src/snapshot/scenes.test.tsx` (new) —
  unit tests to the ≥90% gate (converter cases; each scene renders a non-empty frame; FORCE_COLOR
  capture present in tests via ink-testing-library).
- `packages/tui/scripts/snapshot.mjs` (new, OUTSIDE src) — esbuild-bundles `scenes.tsx`+`ansiToSvg.ts`
  (externalizing ink/react/ink-testing-library/@open-consensus/*), renders each scene to ANSI under
  `FORCE_COLOR=3`, writes `.snapshots/<name>.txt` + `.svg`, then `.png` via `rsvg-convert` (fallback
  `magick`, else skip with notice).
- `packages/tui/package.json` — add `"snapshot": "node scripts/snapshot.mjs"`.
- `.gitignore` — ignore `packages/tui/.snapshots/`.
- `packages/tui/README.md` (new, short) — how to regenerate snapshots and that they exist so an
  agent/dev can see the TUI.

Acceptance criteria:
- `npm run -w @open-consensus/tui snapshot` writes a `.png` per scene (with a renderer present) and
  always writes `.txt`+`.svg`; missing-renderer path prints a notice and exits 0.
- `ansiToSvg` and `scenes` meet the ≥90% line+branch+function+statement gate; `npm test` green.
- `tsup` build does NOT bundle `src/snapshot/**` (verified: not in the `src/index.ts` import graph).
- A generated PNG faithfully shows the current TUI (colors/box/marks) when read as an image.

### Stage 2 — Theme module + restyle the live (dynamic) regions

Centralize the palette and apply it to the always-structured components first (lowest risk, immediate
payoff).

Files:
- `packages/tui/src/theme.ts` (new) — `brand`/`brandDim`/`brandBright`, semantic
  `statusColor(status)`, `verdictColor(verdict)`, accents (prompt, hint/dim, border). Pure constants +
  small pure helpers. Exported from `src/index.ts`.
- `packages/tui/src/ui/segments.ts` (new) — `Segment` type (`{ text; color?; bold?; dim?; inverse? }`)
  + tiny helpers (`seg`, `text`); shared by timeline renderer, Prompt, Transcript.
- `packages/tui/src/session/timeline.ts` — add `timelineRows(t): Segment[][]` (structured, colored)
  next to the existing `timelineLines`. No reducer/state change.
- `packages/tui/src/components/RunTimeline.tsx` — render `timelineRows` with semantic colors: bold
  brand header, colored marks/labels, `verdictColor` for the verdict, theme border color
  (mustard while running, green met, amber degraded, red failed), dim reconnect status.
- `packages/tui/src/components/Prompt.tsx` — brand prompt glyph (`›`/busy), colored cursor, styled
  autocomplete (command name in brand, summary dim, selected row emphasized).
- `packages/tui/src/app.tsx` — style the `working…` indicator via theme (dim/brand).
- Update `scenes.tsx` to include the restyled states; tests adjusted.
- Tests for `theme.ts`, `segments.ts`, `timelineRows`, and updated component tests.

Acceptance criteria:
- Live timeline + prompt + busy reference ONLY `theme.ts` for colors (no scattered literals).
- `timelineRows` covers every `AgentTimelineStatus` + every verdict with a defined color; tested.
- Regenerated PNGs show mustard branding + semantic status colors in the live region and prompt.
- Coverage gate + lint + typecheck green; existing app/Prompt/timeline tests still pass.

### Stage 3 — Rich transcript (segments) + styled command output

Move committed scrollback to a small segment model so history can carry color, preserving the
single-sink redaction guarantee.

Files:
- `packages/tui/src/components/Transcript.tsx` — `TranscriptLine` becomes `{ id; segments: Segment[] }`;
  render each segment as a `<Text>` with its style. `<Static>` semantics unchanged.
- `packages/tui/src/app.tsx` — `print(text|Segment[])` at the SINGLE sink: strings wrap to one default
  segment; redaction runs per-segment `text` (the invariant). Echoed input `› …` styled (dim glyph +
  brand-ish), thrown errors styled red, status/info lines dim where appropriate. ALSO: the
  terminal-state run handoff commits the live timeline via the colored `timelineRows` (Stage 2)
  instead of plain `timelineLines`, so a finished run in scrollback matches its live look — moved here
  from Stage 4 (Gemini finding, round 1: avoids Stage 3 shipping in a half-styled state, and both
  `timelineRows` + `print(Segment[])` are available by now).
- `packages/tui/src/slash/registry.ts` — emit styled output for `help` (usage in brand, summary dim),
  `agents`/`panels`/`runs`/`daemon`/`agent test` (labels dim, ids/values emphasized, healthy=green /
  not-running=dim/red). Handlers still call `ctx.print`; `SlashContext.print` signature widens to
  accept `string | Segment[]`.
- Update `scenes.tsx` (a styled help/agents transcript scene); tests for the new `print`/Transcript
  shape and at least one styled-registry-output assertion.

Acceptance criteria:
- Every existing `ctx.print(...)`/`print(...)` call still compiles and renders (string path intact).
- Redaction still occurs at exactly one place and now covers each segment; a test asserts a secret in
  a segment is redacted in the committed line.
- Errors render red, command headers/usages carry brand, secondary text is dim — visible in PNGs.
- A finished run committed to scrollback is colored identically to its live form (shared
  `timelineRows`); a test asserts the committed handoff uses colored segments.
- Coverage/lint/typecheck green; `app.test.tsx`, `Transcript.test.tsx`, `registry.test.ts` updated &
  passing.

### Stage 4 — Startup banner, committed-timeline color, footer, version wiring

The finishing layer that makes first-launch look like a product.

Files:
- `packages/tui/src/components/Banner.tsx` (new) — returns the banner as styled `Segment[][]` (brand
  wordmark, dim rule, tagline, dim `vX.Y.Z · <cwd>`, hint line). Pure; unit-tested.
- `packages/tui/src/app.tsx` — seed the banner lines via a **lazy `useState` initializer** (replacing
  the single GREETING string), NOT a mount `useEffect`, so it emits exactly once and is StrictMode-safe;
  accept optional `version`/`cwd` props (default `process.cwd()` / `'dev'`). Add a subtle dim
  footer/hint line beneath the prompt (`/help · Tab completes · Ctrl+C cancels/quits`). (The colored
  `timelineRows` run-handoff was moved to Stage 3.)
- `packages/tui/src/index.ts` — `LaunchOptions`/`launchTui` accept optional `version`.
- `packages/cli/src/cli.ts` — pass the already-available CLI `version` into `launchTui` (one line; the
  banner shows it). No other CLI change.
- Update `scenes.tsx` with a full first-launch scene (banner + prompt + footer); tests for `Banner`
  and the committed-timeline color path.

Acceptance criteria:
- First launch shows a branded banner (mustard wordmark + version + cwd + hint) that scrolls into
  history like Claude Code's; a PNG confirms it. The banner emits exactly once (lazy `useState` init;
  StrictMode-safe).
- Footer hint visible and dim; banner shows the real CLI version end-to-end.
- Coverage/lint/typecheck green; full `npm test` + `npm run build` succeed.

## Test / verification strategy

- Pure modules (`ansiToSvg`, `theme`, `segments`, `timelineRows`, `Banner`, `scenes`) unit-tested to
  the ≥90% gate in the normal suite (no renderer needed).
- Each stage: regenerate snapshots (`npm run -w @open-consensus/tui snapshot`) and READ the PNGs to
  visually confirm brand color, bold, semantic status colors, banner, and layout — the core
  user-stated requirement that the agent can see the TUI.
- `npm run build` after Stage 1 and Stage 4 to confirm `src/snapshot/**` is not bundled and the TUI
  still builds.

## Reviewer environment status

- **Codex** — active throughout (returns inline for small diffs; backgrounds long plan/diff reviews —
  those async results are not retrievable, so for large reviews only the inline ones land).
- **Gemini** — active for the plan + Stages 1–4 stage reviews and most fix rounds; went DEGRADED during
  the Stage-4 fix round 2 with `IneligibleTierError` ("no longer supported for Gemini Code Assist for
  individuals; migrate to Antigravity") — the Gemini CLI's individual-tier cutoff lapsed (2026-06-18).
  Unavailable for the Phase-3 final review.
- **Grok** — DEGRADED for the entire build (xAI spending-limit / no active subscription; HTTP 403).
- **opencode** — DEGRADED for the entire build (the auto-mode dispatch routes private-repo source to an
  external cloud model; the sandbox classifier blocks that route).

Net: by Phase 3 only **Codex** remained reachable. Per the graceful-degradation rule, the loop
continued with the available reviewer(s) at each step; the final review leans on Codex plus the
orchestrator's own cross-stage verification.

## Review log

### Plan, round 1
- **Gemini** — 2× LOW, both ACCEPTED & applied: (1) seed banner via lazy `useState` initializer, not a
  mount `useEffect` (StrictMode double-print); (2) move the colored `timelineRows` run-handoff from
  Stage 4 into Stage 3 (avoid a half-styled Stage 3). Validated coverage-gate, redaction-invariant,
  and bundle-scope as sound.
- **Codex** — started a background review task that ran but returned ASYNC; its result was not
  retrievable through available tooling (the rescue wrapper only *starts* tasks; the companion's
  result store is transient). Re-engaged at every stage review, where smaller diffs return inline.

## Deviations from this plan (intentional, reviewed)

- **`timelineLines` was removed**, not retained. The plan kept it for "text-only callers", but a
  Stage-3 review found it had zero consumers once the committed handoff moved to `timelineRows`. Deleted
  in `112b6e4` (prefer-simplicity; no consumer existed).
- **The banner lives at `src/ui/banner.ts`, not `components/Banner.tsx`.** It returns pure data
  (`Segment[][]`) seeded into state, not a React component, so it belongs next to `ui/segments.ts`.
- **The colored timeline-handoff moved from Stage 4 to Stage 3** (Gemini plan-review finding) so Stage 3
  did not ship half-styled.

## Reviewer pushback (rejected)

- **Final review (Codex): couple `ansiToSvg.ts` palette to `theme.ts`.** Rejected — that file's palette
  is the standard ANSI terminal color table (it maps SGR codes 30–37/90–97 etc. to display colors so it
  can render ANY ansi app), conceptually distinct from the brand theme; and it is dev-only/unshipped.
- **Final review (Codex): restore `timelineLines` / move banner to `components/Banner.tsx`.** Rejected —
  see "Deviations from this plan" above (both were deliberate, reviewed choices).
- **Final review (Codex): snapshot scene hardcodes a version → drift.** Partially accepted — it is a
  visual fixture, not a version check (the real flow is asserted in `app.test.tsx`); changed the literal
  to an obviously-illustrative `1.2.3` with a clarifying comment instead of wiring a build version into
  the dev tool.
