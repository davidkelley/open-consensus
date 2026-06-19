import { cancelRunCommand } from '@open-consensus/command-core'
import { redactString } from '@open-consensus/core'
import type { AdapterRegistry } from '@open-consensus/daemon'
import { Box, Text, useApp, useInput } from 'ink'
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import { Prompt } from './components/Prompt'
import { RunTimelineView } from './components/RunTimeline'
import { Transcript, type TranscriptLine } from './components/Transcript'
import { useDaemonEvents } from './hooks/useDaemonEvents'
import type { EventStream, EventStreamDeps } from './session/sse'
import { isTerminal, shortId, timelineRows } from './session/timeline'
import { parseLine } from './slash/parser'
import { type SlashContext, findCommand } from './slash/registry'
import { theme } from './theme'
import { bannerLines } from './ui/banner'
import { type Segment, redactSegments, seg, toSegments } from './ui/segments'

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
  /** Release version shown in the banner (defaults to 'dev'). */
  version?: string
  /** Working directory shown in the banner (defaults to process.cwd()). */
  cwd?: string
}

/** One-line key hint shown under the prompt when idle (the busy indicator takes
 *  its place while a command runs). Keys only — the banner carries /help + /run, so
 *  the two surfaces don't restate the same guidance. */
export const FOOTER_HINT = 'Tab completes · ↑↓ history · Ctrl+C cancels/quits'

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
  // The banner is seeded via a lazy useState initializer (not a mount effect) so it
  // appears exactly once and is React-19-StrictMode-safe. Bypassing the redaction
  // sink is safe ONLY because the banner is built from static text + the version/cwd
  // (no user-controlled content); every DYNAMIC line must still go through print(),
  // which redacts. Do not seed dynamic/user content here.
  const [lines, setLines] = useState<TranscriptLine[]>(() =>
    bannerLines({ version: props.version, cwd: props.cwd }).map((segments, id) => ({
      id,
      segments,
    })),
  )
  // Next transcript id starts after the banner lines.
  const idRef = useRef(lines.length)
  const [runId, setRunId] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const committed = useRef<Set<string>>(new Set())
  const cancelling = useRef(false)
  // A `/run` is dispatching but hasn't returned its id yet.
  const startingRun = useRef(false)
  // A Ctrl+C arrived during that dispatch window — cancel the run once its id lands.
  const cancelRequested = useRef(false)

  // The single transcript sink — so redaction here guarantees NOTHING unredacted
  // reaches the terminal's persistent scrollback, regardless of which handler,
  // command result, or caught error produced the line (D10/D19). Stable across
  // renders; the id is read OUTSIDE the updater so React 19 StrictMode's
  // double-invoke can't skip ids.
  const print = useCallback((line: string | Segment[]): void => {
    const id = idRef.current++
    const segments = redactSegments(toSegments(line), redactString)
    setLines((prev) => [...prev, { id, segments }])
  }, [])

  // Request a server-side cancel of a run (the daemon tree-kills the child and
  // drives the round to a terminal SSE event, which commits it to scrollback).
  const cancelRun = useCallback(
    (id: string): void => {
      const cancel =
        props.cancelRun ??
        ((rid) => cancelRunCommand(props.discoveryPath, rid).then(() => undefined))
      print([seg(`cancelling run ${shortId(id)}… (Ctrl+C again to quit)`, { color: theme.warn })])
      cancel(id)
        .then(() => print([seg(`cancel requested for ${shortId(id)}`, { dim: true })]))
        .catch(() =>
          print([seg('cancel request failed — Ctrl+C again to quit', { color: theme.danger })]),
        )
    },
    [props.cancelRun, props.discoveryPath, print],
  )

  const { timeline, status } = useDaemonEvents({
    runId,
    discoveryPath: props.discoveryPath,
    ...(props.startStream ? { startStream: props.startStream } : {}),
  })

  // Atomic handoff: when the live run reaches a terminal state (completed OR
  // abandoned), commit its final timeline to the <Static> scrollback once and
  // clear the dynamic region (D19). This is also what finalizes a cancelled run,
  // since cancel makes the daemon drive the round to a terminal SSE event.
  useEffect(() => {
    if (timeline && isTerminal(timeline) && !committed.current.has(timeline.runId)) {
      committed.current.add(timeline.runId)
      for (const row of timelineRows(timeline)) print(row)
      setRunId(undefined)
      cancelling.current = false // ready for the next run's Ctrl+C
    }
  }, [timeline, print])

  const ctx: SlashContext = {
    configCtx: { configFile: props.configFile },
    registry: props.registry,
    discoveryPath: props.discoveryPath,
    print,
    ensureDaemon: props.ensureDaemon,
    viewRun: (id) => {
      // Always stream the run. If Ctrl+C was pressed while it was starting, ALSO
      // request a cancel — identical to the active-run path, so a failed/slow
      // cancel keeps the run visible (a second Ctrl+C exits) instead of dropping
      // it from view while it's still alive on the daemon.
      setRunId(id)
      if (cancelRequested.current) {
        cancelRequested.current = false
        cancelling.current = true
        cancelRun(id)
      }
    },
    hasActiveRun: () => runId !== undefined,
    quit: () => doExit(),
  }

  const handleSubmit = (line: string): void => {
    const parsed = parseLine(line)
    if (parsed.kind === 'empty') return
    // print() redacts every segment at the sink (a pasted arg may carry a secret).
    print([seg('› ', { color: theme.brandDim }), seg(line)])
    if (parsed.kind === 'text') {
      print([seg('not a command — type /help (every action is a /command)', { dim: true })])
      return
    }
    const command = findCommand(parsed.name)
    if (!command) {
      print([
        seg(`unknown command '/${parsed.name}'`, { color: theme.danger }),
        seg(' — type /help', { dim: true }),
      ])
      return
    }
    setBusy(true)
    const isRun = parsed.name === 'run'
    if (isRun) startingRun.current = true
    command
      .run(ctx, parsed.args, parsed.rest)
      .catch((err: unknown) =>
        print([
          seg(`error: ${err instanceof Error ? err.message : String(err)}`, {
            color: theme.danger,
          }),
        ]),
      )
      .finally(() => {
        setBusy(false)
        if (isRun) {
          startingRun.current = false
          cancelRequested.current = false
        }
      })
  }

  useInput((input, key) => {
    if (!(key.ctrl && input === 'c')) return
    // Active the moment a run id is set — even before useDaemonEvents publishes
    // the first timeline — so a quick Ctrl+C cancels the run instead of exiting.
    const runActive = runId !== undefined && (timeline === undefined || !isTerminal(timeline))
    if (runActive && !cancelling.current) {
      // First Ctrl+C with an active run: request a server-side cancel. We do NOT
      // clear runId — on a failed/slow cancel the run keeps streaming so nothing
      // is lost, and the terminal SSE event commits it. A SECOND Ctrl+C (cancelling
      // already set) exits, so two presses always quit.
      cancelling.current = true
      cancelRun(runId)
      return
    }
    if (startingRun.current && !cancelRequested.current) {
      // A /run is dispatching but has no id yet — remember to cancel it the moment
      // the id arrives (viewRun), so the run isn't left orphaned on the daemon. A
      // second Ctrl+C still exits.
      cancelRequested.current = true
      print([seg('cancelling the starting run… (Ctrl+C again to quit)', { color: theme.warn })])
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
      {busy ? (
        <Text color={theme.brandDim}>● working…</Text>
      ) : (
        <Text color={theme.muted}>{FOOTER_HINT}</Text>
      )}
    </Box>
  )
}
