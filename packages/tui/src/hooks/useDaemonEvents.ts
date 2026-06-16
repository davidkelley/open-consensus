import { readDiscovery } from '@open-consensus/daemon'
import { useEffect, useState } from 'react'
import {
  type EventStream,
  type EventStreamDeps,
  type StreamStatus,
  startEventStream,
} from '../session/sse'
import { type RunTimeline, applyEvent, emptyTimeline } from '../session/timeline'

export interface UseDaemonEventsOptions {
  /** The run to stream, or undefined to stream nothing. */
  runId: string | undefined
  discoveryPath: string
  /** Injectable SSE stream factory (defaults to the real one) — tests pass a fake. */
  startStream?: (deps: EventStreamDeps) => EventStream
}

/**
 * Subscribe to a run's live timeline over daemon SSE (plan D11/D19). On
 * (re)connect the daemon back-fills missed events from the durable log — that
 * back-fill IS the snapshot — so the timeline reconstructs from seq 0 and then
 * follows live. The subscription is torn down when the run changes or the
 * component unmounts (the `tui-session` lifecycle the CLI deliberately lacks).
 */
export function useDaemonEvents(opts: UseDaemonEventsOptions): {
  timeline: RunTimeline | undefined
  status: StreamStatus | undefined
} {
  const [timeline, setTimeline] = useState<RunTimeline | undefined>(undefined)
  const [status, setStatus] = useState<StreamStatus | undefined>(undefined)
  const start = opts.startStream ?? startEventStream
  const { runId, discoveryPath } = opts

  useEffect(() => {
    if (!runId) {
      setTimeline(undefined)
      setStatus(undefined)
      return
    }
    let current = emptyTimeline(runId)
    setTimeline(current)
    setStatus('connecting')
    const stream = start({
      resolveDiscovery: () => readDiscovery(discoveryPath),
      onEvent: (event) => {
        current = applyEvent(current, event)
        setTimeline(current)
      },
      onStatus: setStatus,
    })
    return () => stream.close()
  }, [runId, discoveryPath, start])

  return { timeline, status }
}
