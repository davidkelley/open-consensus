# @open-consensus/tui

The ink + React slash-command TUI launched by a bare `open-consensus` (plan D19).

## Seeing the TUI (snapshot harness)

The TUI is a terminal UI, so visual changes are easy to break blind. The snapshot
harness renders the real components to PNG images so a developer — or an AI agent
making UI changes — can actually *see* the result, colors and all.

```sh
npm run -w @open-consensus/tui snapshot
```

This renders each scene in [`src/snapshot/scenes.tsx`](src/snapshot/scenes.tsx) and
writes `<scene>.txt` (raw ANSI), `<scene>.svg`, and `<scene>.png` to
`packages/tui/.snapshots/` (gitignored). Open the PNGs to review the styling.

Pipeline: ink component → ANSI frame (via `ink-testing-library` with
`FORCE_COLOR=3`, so chalk emits truecolor) → SVG (the pure, unit-tested
[`ansiFrameToSvg`](src/snapshot/ansiToSvg.ts)) → PNG.

PNG rasterisation prefers [`rsvg-convert`](https://wiki.gnome.org/Projects/LibRsvg)
(`brew install librsvg`) because it does font fallback, so box-drawing **and** the
status-mark glyphs (✓ ✗ ◐ ⌛ ∅ ⊘ ⚠) render. It falls back to ImageMagick
(`magick`), and if neither is installed it still writes the `.txt`/`.svg` and prints
a notice — the harness never hard-fails on a missing rasteriser.

The harness is developer tooling: the pure converter and the scene catalog are
unit-tested and live under `src/`, but the file-writing/process-spawning runner
([`scripts/snapshot.mjs`](scripts/snapshot.mjs)) lives outside `src/` so it is
neither bundled into the published TUI nor counted by the coverage gate.
