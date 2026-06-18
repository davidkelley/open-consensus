import type { AgentTimelineStatus, RunTimeline, RunVerdict } from './session/timeline'

/**
 * The single source of truth for the TUI's look (plan tui-brand-polish). A warm
 * yellow/mustard brand plus a small semantic palette; every component reads colors
 * from here rather than scattering literals, so the product feels consistent and
 * the brand can be retuned in one place.
 *
 * Values are hex so the styling is identical on truecolor terminals; chalk
 * downsamples automatically for low-color terminals, and ink honors `NO_COLOR`.
 */
export const theme = {
  /** Primary brand — mustard. */
  brand: '#d7a14a',
  /** Brighter brand, for emphasis (wordmark, selected row). */
  brandBright: '#e8b75c',
  /** Muted brand, for secondary brand-tinted text. */
  brandDim: '#9c7b3f',
  /** Semantic: success / met / ok. */
  success: '#23d18b',
  /** Semantic: failure / refusal / error. */
  danger: '#f14c4c',
  /** Semantic: caution / timeout / degraded / cancelled. */
  warn: '#e3b341',
  /** Accent for ids and values. */
  accent: '#6cb6ff',
  /** De-emphasised / secondary text. */
  muted: '#8b949e',
} as const

/** Color for an agent's timeline status mark + label. */
export function statusColor(status: AgentTimelineStatus): string {
  switch (status) {
    case 'ok':
      return theme.success
    case 'refusal':
    case 'error':
      return theme.danger
    case 'timeout':
    case 'cancelled':
    case 'interrupted':
      return theme.warn
    case 'running':
      return theme.brand
    default:
      // pending, unavailable
      return theme.muted
  }
}

/** Color for a round verdict. */
export function verdictColor(verdict: RunVerdict): string {
  switch (verdict) {
    case 'met':
      return theme.success
    case 'degraded':
      return theme.warn
    default:
      // failed
      return theme.danger
  }
}

/** Border color for the live run region: brand while running, verdict-tinted when done. */
export function timelineBorderColor(t: RunTimeline): string {
  if (t.abandoned) return theme.warn
  if (t.done) return t.verdict ? verdictColor(t.verdict) : theme.success
  return theme.brand
}
