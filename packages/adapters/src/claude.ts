import type { RunResult } from '@open-consensus/proc'
import { type AdapterOptions, nonExitedResult, probeVersion } from './shared'
import type {
  Adapter,
  AdapterInvocation,
  AdapterInvocationContext,
  AdapterParseResult,
} from './types'

/**
 * Claude Code adapter (plan D8): `claude -p` non-interactive, `--output-format
 * json` for a parseable envelope, and `--permission-mode plan` as the read-only
 * default (plan mode analyzes without editing). The prompt is delivered on stdin
 * (avoids argv/`ps` leakage, D5).
 */
export function createClaudeAdapter(options: AdapterOptions = {}): Adapter {
  const binPath = options.binPath ?? 'claude'
  return {
    id: 'claude',
    capabilities: {
      nonInteractive: true,
      structuredOutput: true,
      sandbox: true,
      promptDelivery: 'stdin',
    },
    detect: () => probeVersion(binPath),
    buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation {
      const args = ['-p', '--output-format', 'json', '--permission-mode', 'plan']
      if (ctx.model) args.push('--model', ctx.model)
      if (ctx.args) args.push(...ctx.args)
      return { file: binPath, args, env: ctx.env ?? {}, stdin: ctx.prompt }
    },
    parse(result: RunResult, _ctx: AdapterInvocationContext): AdapterParseResult {
      const pre = nonExitedResult(result)
      if (pre) return pre
      if (result.exitCode !== 0) {
        return { status: 'error', text: result.stderr, errorClass: `exit-${result.exitCode}` }
      }
      // `--output-format json` emits a single result envelope; extract `.result`.
      try {
        const parsed = JSON.parse(result.stdout) as {
          result?: unknown
          is_error?: boolean
          subtype?: string
        }
        const text = typeof parsed.result === 'string' ? parsed.result : ''
        if (parsed.is_error || parsed.subtype === 'error') {
          return { status: 'error', text, errorClass: parsed.subtype ?? 'error' }
        }
        return { status: 'ok', text }
      } catch {
        // Not JSON (older/text mode) — fall back to the raw stdout.
        return { status: 'ok', text: result.stdout }
      }
    },
  }
}
