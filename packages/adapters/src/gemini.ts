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
 * Gemini adapter (plan D8): `gemini -p <prompt>` non-interactive, `--approval-mode
 * plan` as the read-only default, `-o json` for a parseable envelope. Gemini takes
 * the prompt as an argument (not stdin), so promptDelivery is `arg` — the prompt is
 * not secret (secrets travel via env, D5), with the size cap + `ps`-visibility the
 * documented residual. The mandatory safety/output flags are appended LAST so a
 * config `arg` can't override them.
 */
export function createGeminiAdapter(options: AdapterOptions = {}): Adapter {
  const bin = lazyBinary(options.binPath ?? 'gemini')
  return {
    id: 'gemini',
    capabilities: {
      nonInteractive: true,
      structuredOutput: true,
      sandbox: true,
      promptDelivery: 'arg',
    },
    detect: () => probeVersion(bin()),
    buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation {
      const args = ['-p', ctx.prompt]
      if (ctx.args) args.push(...ctx.args)
      if (ctx.model) args.push('-m', ctx.model)
      args.push('--approval-mode', 'plan', '-o', 'json') // last: wins
      return { file: bin(), args, env: ctx.env ?? {} }
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
      // `-o json` emits a JSON envelope; extract the response text defensively
      // (field name varies by version) and fall back to the raw stdout.
      const parsed = parseJsonLoose(result.stdout) as
        | { response?: unknown; text?: unknown; content?: unknown }
        | undefined
      const field =
        parsed && [parsed.response, parsed.text, parsed.content].find((v) => typeof v === 'string')
      return { status: 'ok', text: typeof field === 'string' ? field : result.stdout }
    },
  }
}
