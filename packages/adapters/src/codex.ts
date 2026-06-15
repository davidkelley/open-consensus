import type { RunResult } from '@open-consensus/proc'
import { type AdapterOptions, nonExitedResult, probeVersion } from './shared'
import type {
  Adapter,
  AdapterInvocation,
  AdapterInvocationContext,
  AdapterParseResult,
} from './types'

/**
 * Codex adapter (plan D8): `codex exec` non-interactive in a `read-only` sandbox.
 * `--skip-git-repo-check` because we run in an ephemeral scratch dir (not a git
 * repo, D20). The prompt is read from stdin. Codex prints its answer as text (no
 * default JSON envelope), so the answer is the cleaned stdout.
 */
export function createCodexAdapter(options: AdapterOptions = {}): Adapter {
  const binPath = options.binPath ?? 'codex'
  return {
    id: 'codex',
    capabilities: {
      nonInteractive: true,
      structuredOutput: false,
      sandbox: true,
      promptDelivery: 'stdin',
    },
    detect: () => probeVersion(binPath),
    buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation {
      const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check']
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
      return { status: 'ok', text: result.stdout }
    },
  }
}
