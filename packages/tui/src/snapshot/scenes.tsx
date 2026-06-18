import { Box } from 'ink'
import type { ReactElement } from 'react'
import { Prompt } from '../components/Prompt'
import { RunTimelineView } from '../components/RunTimeline'
import { Transcript, type TranscriptLine } from '../components/Transcript'
import type { RunTimeline } from '../session/timeline'

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
}

const transcriptLines: TranscriptLine[] = [
  { id: 0, text: 'Open Consensus — type /help for commands, /run <panel> <prompt> to start.' },
  { id: 1, text: '› /agents' },
  { id: 2, text: 'claude  (claude / opus)' },
  { id: 3, text: 'codex  (codex)' },
  { id: 4, text: '› /run review ship the release' },
  { id: 5, text: "started run r-7f3a on panel 'review'" },
  { id: 6, text: 'error: missing prompt' },
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

export const scenes: Scene[] = [
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
]
