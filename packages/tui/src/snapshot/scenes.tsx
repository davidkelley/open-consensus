import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import { FOOTER_HINT } from '../app'
import { Prompt } from '../components/Prompt'
import { RunTimelineView } from '../components/RunTimeline'
import { Transcript, type TranscriptLine } from '../components/Transcript'
import type { RunTimeline } from '../session/timeline'
import { theme } from '../theme'
import { bannerLines } from '../ui/banner'
import { seg } from '../ui/segments'

/**
 * The snapshot scene catalog (plan tui-brand-polish, Stage 1). Each scene is the
 * REAL component tree with fixture data — rendered to an ANSI frame by the runner
 * (`scripts/snapshot.mjs`) and turned into a PNG via {@link ansiFrameToSvg}. Scenes
 * are pure (they only build React elements); the rendering + IO live in the dev
 * runner so this module is safe to unit-test and is never bundled into the TUI.
 */
export interface Scene {
  name: string
  node: ReactElement
  /** Optional keystrokes to type into the scene after it mounts (drives stateful
   *  components like the prompt's autocomplete). */
  input?: string
  /** Constrain the render to N columns (the runner wraps the node in `<Box width>`)
   *  — for verifying narrow-terminal wrapping. */
  width?: number
  /** Render as a NO_COLOR terminal would (the runner strips ANSI from the frame). */
  noColor?: boolean
}

/** A real-shaped run id (randomUUID) so the snapshots expose the UUID-length defect
 *  that the short `r-7f3a` fixtures hide. */
const REAL_RUN_ID = '2f9a1c7e-3b4d-4e5f-8a6b-1c2d3e4f5a6b'

const transcriptLines: TranscriptLine[] = [
  {
    id: 0,
    segments: [
      seg('Open Consensus — type /help for commands, /run <panel> <prompt> to start.', {
        dim: true,
      }),
    ],
  },
  { id: 1, segments: [seg('› ', { color: theme.brandDim }), seg('/agents')] },
  { id: 2, segments: [seg('claude', { bold: true }), seg('  (claude / opus)', { dim: true })] },
  { id: 3, segments: [seg('codex', { bold: true }), seg('  (codex)', { dim: true })] },
  { id: 4, segments: [seg('› ', { color: theme.brandDim }), seg('/run review ship the release')] },
  {
    id: 5,
    segments: [
      seg('started run '),
      seg('r-7f3a', { color: theme.accent, bold: true }),
      seg(" on panel 'review'", { dim: true }),
    ],
  },
  { id: 6, segments: [seg('error: missing prompt', { color: theme.danger })] },
]

const runningTimeline: RunTimeline = {
  runId: 'r-7f3a',
  roundIndex: 1,
  done: false,
  abandoned: false,
  agents: [
    { agentId: 'claude', status: 'ok', attempts: 1 },
    { agentId: 'codex', status: 'running', attempts: 1 },
    { agentId: 'gemini', status: 'pending', attempts: 0 },
    { agentId: 'opencode', status: 'refusal', attempts: 2 },
  ],
}

const doneTimeline: RunTimeline = {
  runId: 'r-7f3a',
  roundIndex: 1,
  done: true,
  abandoned: false,
  verdict: 'met',
  agents: [
    { agentId: 'claude', status: 'ok', attempts: 1 },
    { agentId: 'codex', status: 'ok', attempts: 1 },
    { agentId: 'gemini', status: 'timeout', attempts: 3 },
    { agentId: 'opencode', status: 'ok', attempts: 1 },
  ],
}

// A running timeline keyed by a REAL UUID (exposes the narrow-width header garble).
const realRunningTimeline: RunTimeline = {
  runId: REAL_RUN_ID,
  roundIndex: 1,
  done: false,
  abandoned: false,
  agents: [
    { agentId: 'claude', status: 'ok', attempts: 1 },
    { agentId: 'codex', status: 'running', attempts: 1 },
    { agentId: 'gemini', status: 'pending', attempts: 0 },
    { agentId: 'opencode', status: 'timeout', attempts: 3 },
  ],
}

const abandonedTimeline: RunTimeline = {
  runId: REAL_RUN_ID,
  roundIndex: 2,
  done: false,
  abandoned: true,
  agents: [
    { agentId: 'claude', status: 'ok', attempts: 1 },
    { agentId: 'codex', status: 'running', attempts: 1 },
  ],
}

// Fixtures mirroring the CURRENT command output (pre-refinement), so the snapshots
// baseline the terse empty states / full-UUID /runs / help that later stages improve.
const emptyStateLines: TranscriptLine[] = [
  { id: 0, segments: [seg('› ', { color: theme.brandDim }), seg('/agents')] },
  { id: 1, segments: [seg('no agents configured', { dim: true })] },
  { id: 2, segments: [seg('› ', { color: theme.brandDim }), seg('/panels')] },
  { id: 3, segments: [seg('no panels configured', { dim: true })] },
  { id: 4, segments: [seg('› ', { color: theme.brandDim }), seg('/runs')] },
  { id: 5, segments: [seg('no runs', { dim: true })] },
]

const runsListLines: TranscriptLine[] = [
  { id: 0, segments: [seg('› ', { color: theme.brandDim }), seg('/runs')] },
  {
    id: 1,
    segments: [
      seg(REAL_RUN_ID, { color: theme.accent }),
      seg('  running', { bold: true }),
      seg('  panel=review', { dim: true }),
    ],
  },
]

const helpLines: TranscriptLine[] = [
  { id: 0, segments: [seg('› ', { color: theme.brandDim }), seg('/help')] },
  ...[
    ['/help', 'list available commands'],
    ['/agents', 'list configured agents'],
    ['/run <panel> <prompt…>', 'start a consensus run and watch it live'],
    ['/runs', 'list runs the daemon knows about'],
    ['/quit', 'exit the TUI'],
  ].map(
    ([usage, summary], i): TranscriptLine => ({
      id: i + 1,
      segments: [
        seg((usage as string).padEnd(34), { color: theme.brand }),
        seg(summary as string, { dim: true }),
      ],
    }),
  ),
]

const errorLines: TranscriptLine[] = [
  { id: 0, segments: [seg('› ', { color: theme.brandDim }), seg('/run')] },
  {
    id: 1,
    segments: [
      seg("unknown command '/nope'", { color: theme.danger }),
      seg(' — type /help', { dim: true }),
    ],
  },
  { id: 2, segments: [seg('error: missing prompt', { color: theme.danger })] },
]

const noop = (): void => {}

// Illustrative fixed values — this scene shows what the banner LOOKS like, not the
// real version (that flow is asserted in app.test.tsx: cli.ts → launchTui → App).
const bannerTranscript: TranscriptLine[] = bannerLines({
  version: '1.2.3',
  cwd: '/Users/dev/github.com/davidkelley/open-consensus',
}).map((segments, id) => ({ id, segments }))

export const scenes: Scene[] = [
  {
    name: 'first-launch',
    node: (
      <Box flexDirection="column">
        <Transcript lines={bannerTranscript} />
        <Box marginTop={1}>
          <Prompt onSubmit={noop} busy={false} />
        </Box>
        <Text color={theme.muted}>{FOOTER_HINT}</Text>
      </Box>
    ),
  },
  { name: 'transcript', node: <Transcript lines={transcriptLines} /> },
  { name: 'timeline-running', node: <RunTimelineView timeline={runningTimeline} status="open" /> },
  { name: 'timeline-done', node: <RunTimelineView timeline={doneTimeline} status="open" /> },
  {
    name: 'prompt',
    node: (
      <Box flexDirection="column">
        <Prompt onSubmit={noop} busy={false} />
      </Box>
    ),
  },
  {
    name: 'prompt-autocomplete',
    node: (
      <Box flexDirection="column">
        <Prompt onSubmit={noop} busy={false} />
      </Box>
    ),
    input: '/r',
  },
  // Edge / robustness states (added in tui-dx-refinement Stage 1) — these baseline
  // the defects the later stages fix.
  {
    name: 'narrow-timeline',
    node: <RunTimelineView timeline={realRunningTimeline} status="open" />,
    width: 50,
  },
  { name: 'empty-states', node: <Transcript lines={emptyStateLines} /> },
  { name: 'runs-list', node: <Transcript lines={runsListLines} /> },
  { name: 'help', node: <Transcript lines={helpLines} /> },
  { name: 'error', node: <Transcript lines={errorLines} /> },
  { name: 'abandoned', node: <RunTimelineView timeline={abandonedTimeline} status="open" /> },
  {
    name: 'nocolor-timeline',
    node: <RunTimelineView timeline={realRunningTimeline} status="open" />,
    noColor: true,
  },
  {
    // Exposes the background-only cursor vanishing under NO_COLOR (fixed in Stage 3).
    name: 'nocolor-prompt',
    node: (
      <Box flexDirection="column">
        <Prompt onSubmit={noop} busy={false} />
      </Box>
    ),
    noColor: true,
  },
]
