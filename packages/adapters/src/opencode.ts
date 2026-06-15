import type { RunResult } from '@open-consensus/proc'
import { type AdapterOptions, nonExitedResult, probeVersion } from './shared'
import type {
  Adapter,
  AdapterInvocation,
  AdapterInvocationContext,
  AdapterParseResult,
} from './types'

/**
 * opencode adapter (plan D8): `opencode run <message>` non-interactive. opencode's
 * `run` exposes NO native read-only/sandbox flag, so `sandbox` is **false** — this
 * tool is elevated-opt-in only, behind an explicit acknowledgment that it can
 * read/write/exfiltrate anything the account can reach (D20). The prompt is the
 * positional message argument; output is parsed as cleaned text.
 */
export function createOpencodeAdapter(options: AdapterOptions = {}): Adapter {
  const binPath = options.binPath ?? 'opencode'
  return {
    id: 'opencode',
    capabilities: {
      nonInteractive: true,
      structuredOutput: false,
      sandbox: false,
      promptDelivery: 'arg',
    },
    detect: () => probeVersion(binPath),
    buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation {
      const args = ['run']
      if (ctx.model) args.push('--model', ctx.model)
      if (ctx.args) args.push(...ctx.args)
      args.push(ctx.prompt) // the message is the trailing positional
      return { file: binPath, args, env: ctx.env ?? {} }
    },
    parse(result: RunResult, _ctx: AdapterInvocationContext): AdapterParseResult {
      const pre = nonExitedResult(result)
      if (pre) return pre
      if (result.exitCode !== 0) {
        return { status: 'error', text: result.stderr, errorClass: `exit-${result.exitCode}` }
      }
      return { status: 'ok', text: result.stdout }
    },
  }
}
