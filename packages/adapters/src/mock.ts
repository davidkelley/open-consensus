import type { RunResult } from '@open-consensus/proc'
import type {
  Adapter,
  AdapterInvocation,
  AdapterInvocationContext,
  AdapterParseResult,
} from './types'

/**
 * Deterministic mock adapter (plan D8/Stage 3). It runs a tiny `node -e` program
 * through the *real* process runner, so it exercises the full dispatch path with
 * zero real CLIs / network / spend. Used by all higher-stage (engine, daemon,
 * MCP) tests. Configurable across ok / refusal / error / timeout / slow.
 */

export type MockMode = 'ok' | 'refusal' | 'error' | 'timeout' | 'slow'

const MODES: ReadonlySet<string> = new Set<MockMode>(['ok', 'refusal', 'error', 'timeout', 'slow'])

// A small, ASCII-only node program: read the prompt from stdin, then emit a
// deterministic JSON envelope (or fail / hang) based on the mode.
const MOCK_SCRIPT = [
  "let body='';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data',function(d){body+=d;});",
  "process.stdin.on('end',function(){",
  "var mode=process.argv[1]||'ok';",
  "var delay=Number(process.argv[2]||'300');",
  "if(mode==='timeout'){setTimeout(function(){},60000);return;}",
  "if(mode==='error'){process.stderr.write('mock error');process.exit(1);return;}",
  "if(mode==='refusal'){process.stdout.write(JSON.stringify({status:'refusal',text:'I will not do that.'}));process.exit(0);return;}",
  "if(mode==='slow'){setTimeout(function(){process.stdout.write(JSON.stringify({status:'ok',text:'slow:'+body}));process.exit(0);},delay);return;}",
  "process.stdout.write(JSON.stringify({status:'ok',text:'ok:'+body}));process.exit(0);",
  '});',
].join('')

export interface MockAdapterOptions {
  /** Default mode when the invocation context does not override it. */
  mode?: MockMode
  /** Delay (ms) used by the `slow` mode. */
  slowMs?: number
}

export function createMockAdapter(options: MockAdapterOptions = {}): Adapter {
  const defaultMode = options.mode ?? 'ok'
  return {
    id: 'mock',
    capabilities: {
      nonInteractive: true,
      structuredOutput: true,
      sandbox: true,
      promptDelivery: 'stdin',
    },
    detect: () => Promise.resolve({ available: true, version: process.version }),
    buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation {
      // The mode may be overridden per-invocation via a NAMESPACED model string
      // ('mock:error' etc.), so a real model name like 'opus' is never mistaken
      // for a mock mode.
      const override = ctx.model?.startsWith('mock:') ? ctx.model.slice('mock:'.length) : undefined
      const mode = override && MODES.has(override) ? (override as MockMode) : defaultMode
      return {
        file: process.execPath,
        args: ['-e', MOCK_SCRIPT, mode, String(options.slowMs ?? 300)],
        env: ctx.env ?? {},
        stdin: ctx.prompt,
      }
    },
    parse(result: RunResult, _ctx: AdapterInvocationContext): AdapterParseResult {
      switch (result.outcome) {
        case 'timeout':
          return { status: 'error', text: '', errorClass: 'timeout' }
        case 'cancelled':
          return { status: 'error', text: '', errorClass: 'cancelled' }
        case 'output-overflow':
          return { status: 'error', text: result.stdout, errorClass: 'output-overflow' }
        case 'spawn-error':
          return { status: 'error', text: '', errorClass: result.error ?? 'spawn-error' }
        default:
          break
      }
      if (result.exitCode !== 0) {
        return { status: 'error', text: result.stderr, errorClass: `exit-${result.exitCode}` }
      }
      try {
        const parsed = JSON.parse(result.stdout) as { status?: string; text?: string }
        return {
          status: parsed.status === 'refusal' ? 'refusal' : 'ok',
          text: String(parsed.text ?? ''),
        }
      } catch {
        return { status: 'error', text: result.stdout, errorClass: 'unparseable' }
      }
    },
  }
}

/** A ready-to-use mock adapter in the default (`ok`) mode. */
export const mockAdapter = createMockAdapter()
