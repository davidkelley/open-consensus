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
}

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

const noop = (): void => {}

const bannerTranscript: TranscriptLine[] = bannerLines({
  version: '0.1.1',
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
]
