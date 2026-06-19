# PLAN — tui-dx-refinement

## Goal

Refine the just-shipped TUI brand polish (PR #1, branch `tui-brand-polish`) into a genuinely robust,
legible, beautiful developer experience. Fix the one place it actually breaks (narrow terminals garble
the most prominent line), make a running consensus read as *alive*, tighten the palette so color
encodes meaning, and guide newcomers — without adding features or complexity beyond what the DX needs.

Driven by a deep-dive analysis (4 diverse lenses + a synthesis critic) cross-checked against first-hand
rendered-PNG inspection of every state (the snapshot harness).

## Assumptions

- Real run ids are `randomUUID()` (36 chars, verified `engine.ts:263`), so any UI that prints the raw id
  is both noisy and a wrap hazard. A short form (first 8 hex) is unambiguous within a session; the full
  id is only needed on the machine path (the cancel RPC), which keeps it.
- ink word-wraps a single `<Text>` with **nested** styled `<Text>` children as one paragraph; it wraps a
  `<Box>` flex-row of separate `<Text>` segments independently (the current garble). Verified by rendering
  the timeline at width 44 (header fragmented into `rurun-…-i / entifier … roun — / running`).
- ink honors `NO_COLOR` via chalk (level 0 strips ALL styling, not just color). A snapshot rendered with
  ANSI stripped is a faithful proxy for a NO_COLOR / low-color terminal.
- `ink-testing-library` hardcodes `columns = 100`, so width is controlled by wrapping the *dynamic*
  components (RunTimelineView/Prompt) in `<Box width={N}>` — sufficient because the garble is in the
  dynamic region. The `<Static>` transcript wraps at the real terminal width in production (forgiving
  paragraph wrap); we don't need to force-narrow it in snapshots.
- The single-redaction-sink invariant (every dynamic line through `app.tsx print`, redacted per-segment;
  only the static banner bypasses) MUST be preserved by every change here.
- Presentation-only: no engine/daemon/command-core changes. The second-`/run`-while-streaming guard
  already exists (`registry.ts:207`), so the elapsed timer only ever tracks one run.

## Non-goals

- **No new commands / features.** In particular NO `/quickstart`, NO run-inspection command. (See
  "Deferred" — gap: you can't retrieve a finished run's detail. That is a real product gap but it is a
  feature, not polish; out of scope here. We do make `/runs` show the verdict of finished runs as a lean
  partial.)
- No keyboard-cycling autocomplete (stateful selection that fights the history binding) — sorting only.
- No elapsed/wall-clock timer (needs a daemon start-timestamp; misleading on reconnect). Liveness is the
  lean spinner only (Decision #5).
- No new runtime dependency (no `string-width` for mark padding — pick width-1 glyphs instead).
- No transcript truncation / fold / "N earlier lines" affordance (speculative; panels are small). Noted
  in Deferred.
- No light-background theme switching / `NO_COLOR` config UI — only ensure meaning survives (marks +
  labels + a visible cursor), verified by a NO_COLOR snapshot.

## Decisions made (reviewers: push back if wrong)

1. **Short run ids (first 8 chars) everywhere user-facing**; full UUID only for the cancel RPC. A
   `shortId()` helper in `session/timeline.ts`. 8 hex = 32 bits; a session has a handful of runs, so
   collision is negligible — and it is **display-only** (the cancel path uses the full UUID), so even a
   cosmetic collision has no functional effect. Matches the git-short-SHA convention developers expect.
2. **Segment-rows become one `<Text>` of nested `<Text>` spans** (a shared `<SegmentLine>` used by both
   RunTimeline and Transcript — also removes the duplicated render block the code lens flagged).
   **Empirically validated on ink 7/Yoga** (a reviewer doubted it): at width 40 the flex-`<Box>` row
   garbles (`ru2f9a…-uu / roun3 — / running`) while the nested-`<Text>` row wraps cleanly as one
   paragraph (`run 2f9a…-here / round 3 — running`). Stage 2 locks this with a width-constrained wrap test.
3. **Drop `theme.accent` (the lone cool blue).** Short run ids recede in `muted`; the active id stays
   bold. One warm accent family; net-negative LOC.
4. **`warn` moves to amber `#d9822b`** so caution is visibly distinct from the mustard brand (they were
   ~8% apart, so `◐ running` and `⌛ timeout` were indistinguishable by color).
5. **Liveness = a lean spinner on the running mark, NOT an elapsed timer.** The elapsed mm:ss timer is
   dropped (a from-mount timer shows a misleading `00:00` after an SSE reconnect, and *correct* elapsed
   needs a daemon-provided start timestamp — an engine change that violates presentation-only). Instead,
   cycle the `running` status mark `◐ ◓ ◑ ◒` (round 2, Gemini HIGH: a fully static `◐` during a 30–60s
   agent invocation reads as frozen). This restores the heartbeat with none of the timer's problems: no
   false precision, no reconnect dependency (a reconnect just restarts the cycle, which is correct for a
   spinner), ~8 lines. Implemented lean + deterministic: a PURE `spinnerMark(frame)` selector, the frame
   held in `RunTimelineView` via `useState`+a `useEffect` interval. **Lifecycle (round 3, Gemini+opencode
   HIGH):** the effect depends ONLY on stable booleans/strings — `running = !isTerminal(timeline)` and
   `timeline.runId` — NOT the raw `timeline` object (else every SSE event tears down + recreates the
   interval and the spinner visibly freezes). The interval is created only while `running`, and the
   cleanup `clearInterval` fires on unmount AND whenever it goes terminal or the runId changes (so it
   never outlives its run). A stale tick is harmless anyway: `frame` only selects the `running` mark, and a
   terminal timeline has no `running` agents, so a late increment renders nothing. snapshots/tests seed
   frame 0 (`◐`) for determinism.
6. **Visible cursor glyph** `▎` (foreground) that **REPLACES** the current background-only block cursor
   (`Prompt.tsx` `<Text backgroundColor>`), so there is exactly one cursor and it survives NO_COLOR.
7. **Redaction scope is explicit:** the committed transcript (the persistent `<Static>` scrollback) is
   redacted at the single `app.tsx print` sink, per-segment — unchanged. The in-progress live region
   (RunTimelineView) renders `timelineRows` directly from daemon-sourced **structured ids/enums**
   (UUID runId, config agentIds, verdict enum) — never user free-text — so it is intentionally outside
   the redaction contract; it is also redacted again when committed via `print` on handoff. The
   `SegmentLine` refactor does not change which data is rendered, so it does not affect this. (Round 2,
   Gemini NIT: `agentId` IS user-supplied via `/agent add <id>`; if someone pasted a secret as an id it
   would show unredacted in the LIVE region only — the committed transcript is still scrubbed. An inline
   comment by the bypass will warn a future author not to widen the bypassed fields without thinking.)
8. **Width-1 status marks** for `timeout`/`interrupted` (`⌛`→`◴`, `⚠`→`▲`; confirmed wcwidth=1) so the
   agent list stays column-aligned; a test asserts every `STATUS_MARK` is width-1 via the dev-only
   `string-width` (not a runtime dep).
9. **Lean copy only** for newcomer guidance: actionable empty states + one concept line in `/help`
   (`panel = agents · quorum = agreements needed · verdict: met/degraded/failed`). No tutorial system.
10. **Stage 1 ships the verification scenes first** (narrow, NO_COLOR, empty, /help, error, abandoned) so
    every later fix is visually confirmable; the fixtures use a REAL UUID (the current `r-7f3a` fixture
    hides the very defect). Scene content-tests assert structure (e.g. the 8-char id format) so a format
    regression is caught, and any format change updates the scene fixtures + tests in the SAME stage.

## Stages

### Stage 1 — Snapshot harness: make the broken/edge states visible

Build the verification surface first; it establishes the pre-fix baseline (garbled narrow header,
invisible NO_COLOR cursor) and makes every later stage confirmable.

Files: `packages/tui/src/snapshot/scenes.tsx`, `packages/tui/scripts/snapshot.mjs`,
`packages/tui/src/snapshot/scenes.test.tsx`.
- Scene interface gains `width?: number` (scene node pre-wrapped in `<Box width>`) and `noColor?: boolean`.
- Runner strips ANSI from the frame when `noColor` (a tiny `stripAnsi`), simulating NO_COLOR.
- New scenes: `narrow-timeline` (real UUID, width 50), `empty-states` (no agents/panels/runs lines),
  `runs-list` (a `/runs` render), `help` (the /help rows), `error` (an error line), `abandoned`
  (abandoned timeline), `nocolor-timeline`.
- Stage 1 fixtures use the RAW UUID and assert on it; the 8-char short-format assertion is added in
  Stage 2 alongside `shortId` (don't pre-assert a format that doesn't exist yet).
- Tests: scenes render; new scenes present; `stripAnsi` unit-tested.

Acceptance:
- `npm run -w @open-consensus/tui snapshot` emits the new PNGs; reading them shows the CURRENT garble +
  invisible cursor (baseline) and the empty/help/error/abandoned states.
- Gate + lint + typecheck green; harness still excluded from the bundle.

### Stage 2 — Narrow-width robustness (the HIGH cluster)

Files: `packages/tui/src/ui/SegmentLine.tsx` (new), `components/RunTimeline.tsx`, `components/Transcript.tsx`,
`session/timeline.ts`, `slash/registry.ts`, + tests.
- `<SegmentLine segments={…} />`: one `<Text>` wrapping nested `<Text>` spans; replaces the per-row
  `<Box>` flex-row in RunTimeline and Transcript (shared, de-duplicated).
- `shortId(id)` in `timeline.ts`; used in `timelineRows()` head, `/run` echo, `/runs` list, AND the
  `app.tsx` cancel echo (`cancelling run <short>…`). Full UUID retained for `cancelRunCommand` (machine path).
- (`/runs` keeps showing the run `state` it already has — NOT a verdict. Round 2: the runs-list envelope
  is `{runId, panelId, state, createdAt}`; verdict lives on the round, so surfacing it would need a daemon
  change — out of presentation-only scope. The verdict "partial" is dropped; full run inspection stays
  deferred.)
- Empty-agents round: `timelineRows` renders an explicit dim `(no agents in this round)` row when
  `agents` is empty (so it isn't a silent stall).

Acceptance:
- Re-rendered narrow scene: header wraps cleanly, no fragments; short ids shown (incl. the `/runs` scene
  from Stage 1, re-rendered with short ids).
- A width-constrained test (`<Box width={40}>`) asserts the timeline header wraps cleanly: the frame
  contains the short id as a CONTIGUOUS substring (e.g. `run 2f9a1c7e`) and no line splits it mid-token
  (locks the empirically-validated nested-`<Text>` fix against future ink changes).
- `SegmentLine` introduces NO new render path outside the existing redaction boundary (`timelineRows` for
  the live region; `print`→`redactSegments` for committed lines) — it only changes the element shape.
- `shortId`, `SegmentLine`, and the empty-agents row are unit-tested; the cancel echo uses the short id;
  existing timeline/transcript/app tests still pass; gate/lint/typecheck green.

### Stage 3 — Liveness (spinner) + NO_COLOR cursor + abandoned clarity

Files: `session/timeline.ts` (spinnerMark + abandoned copy), `components/RunTimeline.tsx` (spinner state),
`components/Prompt.tsx` (cursor), + tests.
- Spinner: a PURE `spinnerMark(frame)` cycling `◐ ◓ ◑ ◒`; `RunTimelineView` holds the frame in
  `useState` + a `useEffect` interval. The effect deps are `[running, timeline.runId]` (where `running =
  !isTerminal(timeline)`), NOT the raw timeline object; the interval runs only while `running` and its
  `clearInterval` cleanup fires on unmount + on going-terminal + on runId change. `timelineRows(t, frame?)`
  uses it for the `running` mark (frame defaults to 0 → `◐`, so the committed/handoff render and snapshots
  stay deterministic).
- Cursor: REPLACE the background-only block (`<Text backgroundColor={theme.brand}> </Text>`) with a
  foreground glyph `<Text color={theme.brand}>▎</Text>` — exactly one cursor, visible under NO_COLOR.
- Abandoned: clearer header copy, e.g. `(abandoned — no orchestrator driving it; Ctrl+C-safe)` or, if
  "orchestrator" reads as jargon, `(abandoned — the run stopped receiving updates)`. Final wording chosen
  at implementation for clarity to a first-timer.
- Add the missing `run-readopted` reducer test (abandoned→re-adopted clears the label).

Acceptance:
- Running scene shows the spinner mark; the interval is cleared on unmount AND on going-terminal (a test
  asserts no tick fires after unmount / after the run completes, via fake timers); `spinnerMark` is pure +
  unit-tested.
- NO_COLOR scene shows a visible cursor; the background-block `<Text backgroundColor={…}> </Text>` is
  **deleted, not supplemented** (exactly one cursor); abandoned reads understandably; `run-readopted` is
  tested. Gate/lint/typecheck green.

### Stage 4 — Newcomer guidance + autocomplete relevance

Files: `slash/autocomplete.ts`, `slash/registry.ts`, `ui/banner.ts`, `app.tsx` (FOOTER_HINT), + tests.
- Autocomplete sort: exact name first, then ascending `name.length` (so `/r` → `/run` before `/runs`).
- Empty states gain a dim next-step hint (`no agents configured — add one with /agent add <id> --adapter
  <claude|codex|…>`, etc.); `/help` gains one dim concepts line.
- Split hints: banner teaches the workflow; FOOTER_HINT trimmed to keys only (`Tab completes · ↑↓ history
  · Ctrl+C cancels/quits`).

Acceptance:
- `autocomplete('/r')[0].value === '/run'` (an EXPLICIT order assertion, not just presence); empty states
  + /help concept line present; no /help+Ctrl+C overlap between banner and footer.
- While in `registry.ts`, close the pre-existing coverage gaps the panel flagged: a test for an agent
  WITH a `model` (the `/agents` model branch) and for the absent-`--flag` path. Tests updated;
  gate/lint/typecheck green.

### Stage 5 — Visual cohesion polish

Files: `theme.ts`, `session/timeline.ts` (marks + id color), `components/RunTimeline.tsx`, `app.tsx`
(busy glyph), + tests.
- Drop `theme.accent`; short ids colored `muted` (recede) / bold when active.
- `warn` → amber `#d9822b`.
- Timeline box hugs content: `alignSelf="flex-start"` on the bordered `<Box>`.
- Width-1 marks for `timeout`/`interrupted`; a test asserts every `STATUS_MARK` glyph is width-1.
- Unify the brand glyph: busy line `● working…` → `◆ working…`. (`◆` is the BRAND-identity mark — same as
  the banner wordmark — a deliberately separate family from the `◐◓◑◒` status/progress spinner and the
  `✓✗◴∅⊘▲` status marks; the goal is one brand glyph for "this is Open Consensus", distinct from the
  semantic status set.)

Acceptance:
- One warm accent (no blue); `warn` visibly distinct from `brand`; box hugs content; all marks width-1
  (tested); busy uses `◆`. A sweep confirms **no remaining `theme.accent` references in
  `packages/tui/src`** (typecheck fails if `accent` is referenced after removal). Snapshots re-read to
  confirm. Gate/lint/typecheck + full build green.

## Verification strategy

- Each stage regenerates snapshots; the orchestrator READS the PNGs (narrow, NO_COLOR, empty, help,
  error, abandoned, running, done) to confirm beauty + robustness — the capability the user values.
- Pure modules (`shortId`, `SegmentLine`, autocomplete sort, `stripAnsi`, mark-width) unit-tested to the
  ≥90% gate. `npm run build` after Stage 1 and Stage 5 confirms `src/snapshot/**` stays unbundled.

## Deferred (with rationale)

- **Run inspection (`/run <id>` / `/runs` drill-down to verdict + per-agent output).** The biggest
  functional gap behind a perfect DX (you can't retrieve what a finished id refers to), but it is a new
  feature needing a daemon read path — out of scope for a polish pass. Even the lean partial (a verdict
  column in `/runs`) is infeasible here: the runs-list envelope carries only `state`, not verdict
  (verdict is per-round), so it would require a daemon change. `/runs` continues to show `state`.
- **Transcript unbounded growth / fold.** Speculative; consensus panels are small (2–5 agents). Revisit
  if a large-panel use case appears.
- **Elapsed / liveness timer on the running header.** A *correct* elapsed needs the run's start timestamp
  delivered from the daemon (an engine/event change), which is outside this presentation-only pass; a
  from-mount timer is misleading on reconnect (Gemini HIGH) and adds lifecycle/determinism complexity
  (opencode HIGH). Deferred until a server-provided `startedAt` exists. Liveness today = the SSE
  reconnect-status + per-agent status transitions.
- **Over-engineered (dropped per the critic + lean preference):** `/quickstart` command,
  keyboard-cycling autocomplete, `string-width`-based mark padding, and the elapsed/mm:ss timer. (A lean
  spinner IS kept — Decision #5 — as the primary liveness signal now that the timer is gone.)

## Reviewer status (plan phase)

Four rounds. **Codex** returned "No findings" (R3). **Gemini** "No findings" (R4). **opencode** drove the
most iteration (it tends to re-review the working tree against plan targets — those "not implemented"
items are Phase-2 work, not plan defects); its substantive items (no `/runs` verdict data; spinner
lifecycle; cursor-delete; accent sweep; shortId justification) were all applied. **Grok** was DEGRADED
every round (xAI spending-limit, HTTP 403). Converged: the design is agreed; remaining opencode items were
doc-precision/over-specification, addressed where cheap.

## Reviewer pushback (rejected)

- **opencode (plan, HIGH): nested-`<Text>` may still wrap badly on ink 7/Yoga.** Empirically refuted —
  rendered both at width 40: flex-`<Box>` garbles, nested-`<Text>` wraps as one clean paragraph. Approach
  kept; a width-constrained wrap test added (Stage 2) to lock it.
- **opencode (plan, HIGH): the live region bypasses the single redaction sink.** Acknowledged as a
  pre-existing, intentional boundary (the live region shows only structured daemon ids/enums, never user
  free-text; the committed handoff is still redacted via `print`). Documented in Decision #7 rather than
  adding redaction to the live region (which would be gold-plating). No code change.
- **opencode (plan round 2): a list of HIGH/MED "not implemented" findings** (SegmentLine/shortId/accent/
  cursor/marks/copy not in the code). Rejected as category-error for a PLAN review — these are the plan's
  Stage 2–5 *targets*, not defects; they land during Phase 2. opencode confirmed the actual resolutions
  are sound. The one substantive item (no `/runs` verdict data) was accepted and the sub-item dropped.
- **Reversal noted (defensible):** the deep-dive critic said "drop the spinner, keep the elapsed timer";
  this plan does the opposite (drop the timer, keep a spinner). Justified: once the timer is gone for
  reconnect-correctness, the spinner is no longer redundant decoration — it becomes the primary liveness
  signal, and it has none of the timer's correctness problems (Gemini round-2 HIGH made this case).
