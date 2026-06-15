import type { RunResult } from '@open-consensus/proc'
import { type AdapterOptions, nonExitedResult, probeVersion } from './shared'
import type {
  Adapter,
  AdapterInvocation,
  AdapterInvocationContext,
  AdapterParseResult,
} from './types'

/**
 * Gemini adapter (plan D8): `gemini -p <prompt>` non-interactive, `--approval-mode
 * plan` as the read-only default, `-o json` for a parseable envelope. Gemini takes
 * the prompt as an argument (not stdin), so promptDelivery is `arg` — the prompt is
 * not secret (secrets travel via env, D5), but the size cap and `ps`-visibility
 * are the documented residual.
 */
export function createGeminiAdapter(options: AdapterOptions = {}): Adapter {
  const binPath = options.binPath ?? 'gemini'
  return {
    id: 'gemini',
    capabilities: {
      nonInteractive: true,
      structuredOutput: true,
      sandbox: true,
      promptDelivery: 'arg',
    },
    detect: () => probeVersion(binPath),
    buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation {
      const args = ['-p', ctx.prompt, '--approval-mode', 'plan', '-o', 'json']
      if (ctx.model) args.push('-m', ctx.model)
      if (ctx.args) args.push(...ctx.args)
      return { file: binPath, args, env: ctx.env ?? {} }
    },
    parse(result: RunResult, _ctx: AdapterInvocationContext): AdapterParseResult {
      const pre = nonExitedResult(result)
      if (pre) return pre
      if (result.exitCode !== 0) {
        return { status: 'error', text: result.stderr, errorClass: `exit-${result.exitCode}` }
      }
      // `-o json` emits a JSON envelope; extract the response text defensively
      // (field name varies by version) and fall back to the raw stdout.
      try {
        const parsed = JSON.parse(result.stdout) as {
          response?: unknown
          text?: unknown
          content?: unknown
        }
        const text = [parsed.response, parsed.text, parsed.content].find(
          (v) => typeof v === 'string',
        )
        return { status: 'ok', text: typeof text === 'string' ? text : result.stdout }
      } catch {
        return { status: 'ok', text: result.stdout }
      }
    },
  }
}
