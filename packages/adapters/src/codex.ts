import type { RunResult } from '@open-consensus/proc'
import {
  type AdapterOptions,
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

/** Config args that would defeat codex's read-only sandbox (D20). */
const FORBIDDEN = ['--sandbox', '--dangerously-bypass-approvals-and-sandbox']

/**
 * Codex adapter (plan D8): `codex exec` non-interactive in a `read-only` sandbox.
 * `--skip-git-repo-check` because we run in an ephemeral scratch dir (not a git
 * repo, D20). The prompt is read from stdin. Codex prints its answer as text (no
 * default JSON envelope), so the answer is the cleaned stdout. The mandatory
 * sandbox flags are appended LAST so a config `arg` can't override them.
 */
export function createCodexAdapter(options: AdapterOptions = {}): Adapter {
  const bin = lazyBinary(options.binPath ?? 'codex')
  return {
    id: 'codex',
    capabilities: {
      nonInteractive: true,
      structuredOutput: false,
      sandbox: true,
      promptDelivery: 'stdin',
    },
    detect: () => probeVersion(bin()),
    buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation {
      const args = ['exec']
      if (ctx.args) {
        assertSafeArgs(ctx.args, FORBIDDEN)
        args.push(...ctx.args)
      }
      if (ctx.model) args.push('--model', ctx.model)
      args.push('--sandbox', 'read-only', '--skip-git-repo-check') // last: wins
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
      return { status: 'ok', text: result.stdout }
    },
  }
}
