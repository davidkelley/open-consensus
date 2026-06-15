import type { RunResult } from '@open-consensus/proc'
import {
  type AdapterOptions,
  assertPromptSize,
  assertSafeArgs,
  lazyBinary,
  nonExitedResult,
  probeVersion,
} from './shared'
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
 * read/write/exfiltrate anything the account can reach (D20); `defaultRegistry`
 * excludes it unless opted in. The prompt is the positional message argument,
 * guarded by `--` so a prompt starting with `-` isn't read as a flag.
 */
export function createOpencodeAdapter(options: AdapterOptions = {}): Adapter {
  const bin = lazyBinary(options.binPath ?? 'opencode')
  return {
    id: 'opencode',
    capabilities: {
      nonInteractive: true,
      structuredOutput: false,
      sandbox: false,
      promptDelivery: 'arg',
    },
    detect: () => probeVersion(bin()),
    buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation {
      assertPromptSize(ctx.prompt) // argv delivery -> bound the prompt size (D5)
      const args = ['run']
      if (ctx.args) {
        assertSafeArgs(ctx.args, []) // reject a config `--` so our prompt guard holds
        args.push(...ctx.args)
      }
      if (ctx.model) args.push('--model', ctx.model)
      args.push('--', ctx.prompt) // end-of-options, then the message positional
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
      return { status: 'ok', text: result.stdout }
    },
  }
}
