import { cancelRunCommand } from '@open-consensus/command-core'
import type { AdapterRegistry } from '@open-consensus/daemon'
import { Box, Text, useApp, useInput } from 'ink'
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import { Prompt } from './components/Prompt'
import { RunTimelineView } from './components/RunTimeline'
import { Transcript, type TranscriptLine } from './components/Transcript'
import { useDaemonEvents } from './hooks/useDaemonEvents'
import type { EventStream, EventStreamDeps } from './session/sse'
import { timelineLines } from './session/timeline'
import { parseLine } from './slash/parser'
import { type SlashContext, findCommand } from './slash/registry'

export interface AppProps {
  configFile: string
  discoveryPath: string
  registry: AdapterRegistry
  /** Ensure the daemon is up (auto-start) — wired by the launcher, faked in tests. */
  ensureDaemon: () => Promise<void>
  /** Cancel a run (defaults to the daemon cancel RPC). */
  cancelRun?: (runId: string) => Promise<void>
  /** Injectable SSE stream factory for the live timeline (tests pass a fake). */
  startStream?: (deps: EventStreamDeps) => EventStream
  /** Exit override (defaults to ink's useApp().exit). */
  exit?: () => void
}

const GREETING =
  'Open Consensus — type /help for commands, /run <panel> <prompt> to start, Ctrl+C to cancel/quit.'

/**
 * The claude-code-style slash-command TUI (plan D19). Finalized lines live in the
 * `<Transcript>` (`<Static>`); the in-progress run renders in a separate dynamic
 * `<RunTimelineView>` and is committed to the transcript in one atomic transition
 * on completion. Slash commands are thin calls into `command-core` (no logic dup
 * with the CLI). Ctrl+C cancels an active run server-side, else exits.
 */
export function App(props: AppProps): ReactElement {
  const ink = useApp()
  const doExit = props.exit ?? ink.exit
  const [lines, setLines] = useState<TranscriptLine[]>([{ id: 0, text: GREETING }])
  const idRef = useRef(1)
  const [runId, setRunId] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const committed = useRef<Set<string>>(new Set())
  const cancelling = useRef(false)

  // Stable across renders (setLines + idRef are stable) so the completion effect
  // can list it as a dependency without re-firing every render.
  const print = useCallback((text: string): void => {
    setLines((prev) => [...prev, { id: idRef.current++, text }])
  }, [])

  const { timeline, status } = useDaemonEvents({
    runId,
    discoveryPath: props.discoveryPath,
    ...(props.startStream ? { startStream: props.startStream } : {}),
  })

  // Atomic handoff: when the live run completes, commit its final timeline to the
  // <Static> scrollback once and clear the dynamic region (D19).
  useEffect(() => {
    if (timeline?.done && !committed.current.has(timeline.runId)) {
      committed.current.add(timeline.runId)
      for (const line of timelineLines(timeline)) print(line)
      setRunId(undefined)
    }
  }, [timeline, print])

  const ctx: SlashContext = {
    configCtx: { configFile: props.configFile },
    registry: props.registry,
    discoveryPath: props.discoveryPath,
    print,
    ensureDaemon: props.ensureDaemon,
    viewRun: (id) => setRunId(id),
    quit: () => doExit(),
  }

  const handleSubmit = (line: string): void => {
    const parsed = parseLine(line)
    if (parsed.kind === 'empty') return
    print(`› ${line}`)
    if (parsed.kind === 'text') {
      print('not a command — type /help (every action is a /command)')
      return
    }
    const command = findCommand(parsed.name)
    if (!command) {
      print(`unknown command '/${parsed.name}' — type /help`)
      return
    }
    setBusy(true)
    command
      .run(ctx, parsed.args, parsed.rest)
      .catch((err: unknown) => print(`error: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusy(false))
  }

  useInput((input, key) => {
    if (!(key.ctrl && input === 'c')) return
    const runActive = runId !== undefined && timeline !== undefined && !timeline.done
    if (runActive && !cancelling.current) {
      // First Ctrl+C with an active run: cancel it server-side (tree-kills the
      // child) — a second Ctrl+C falls through to exit, so two always terminate.
      cancelling.current = true
      const cancel =
        props.cancelRun ?? ((id) => cancelRunCommand(props.discoveryPath, id).then(() => undefined))
      print(`cancelling run ${runId}… (Ctrl+C again to quit)`)
      cancel(runId)
        .then(() => print(`cancelled run ${runId}`))
        .catch(() => print('cancel request failed'))
        .finally(() => {
          setRunId(undefined)
          cancelling.current = false
        })
      return
    }
    doExit()
  })

  return (
    <Box flexDirection="column">
      <Transcript lines={lines} />
      <RunTimelineView timeline={timeline} status={status} />
      <Box marginTop={1}>
        <Prompt onSubmit={handleSubmit} busy={busy} />
      </Box>
      {busy ? <Text dimColor>working…</Text> : null}
    </Box>
  )
}
