import type { RunResult } from '@open-consensus/proc'
import {
  type AdapterOptions,
  lazyBinary,
  nonExitedResult,
  parseJsonLoose,
  probeVersion,
} from './shared'
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
 * (avoids argv/`ps` leakage, D5). The mandatory safety/output flags are appended
 * LAST so a stray config `arg` can't override them (CLI parsers take last-wins).
 */
export function createClaudeAdapter(options: AdapterOptions = {}): Adapter {
  const bin = lazyBinary(options.binPath ?? 'claude')
  return {
    id: 'claude',
    capabilities: {
      nonInteractive: true,
      structuredOutput: true,
      sandbox: true,
      promptDelivery: 'stdin',
    },
    detect: () => probeVersion(bin()),
    buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation {
      const args = ['-p']
      if (ctx.args) args.push(...ctx.args)
      if (ctx.model) args.push('--model', ctx.model)
      args.push('--output-format', 'json', '--permission-mode', 'plan') // last: wins
      return { file: bin(), args, env: ctx.env ?? {}, stdin: ctx.prompt }
    },
    parse(result: RunResult, _ctx: AdapterInvocationContext): AdapterParseResult {
      const pre = nonExitedResult(result)
      if (pre) return pre
      if (result.exitCode !== 0) {
        return {
          status: 'error',
          text: result.stderr || result.stdout,
          errorClass: `exit-${result.exitCode}`,
        }
      }
      // `--output-format json` emits a single result envelope; extract `.result`.
      const parsed = parseJsonLoose(result.stdout) as
        | { result?: unknown; is_error?: boolean; subtype?: string }
        | undefined
      if (parsed === undefined) {
        // Not JSON (older/text mode) — fall back to the raw stdout.
        return { status: 'ok', text: result.stdout }
      }
      if (typeof parsed.result !== 'string') {
        // Envelope shape drifted — surface it rather than masking as empty `ok`.
        return { status: 'error', text: result.stdout, errorClass: 'unparseable-result' }
      }
      if (parsed.is_error || parsed.subtype === 'error') {
        return { status: 'error', text: parsed.result, errorClass: parsed.subtype ?? 'error' }
      }
      return { status: 'ok', text: parsed.result }
    },
  }
}
