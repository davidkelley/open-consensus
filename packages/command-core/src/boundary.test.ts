import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * CI boundary check (plan D19 / Stage 8): `command-core` is the STATELESS layer.
 * It must never import the TUI's `tui-session` (Stage 9) or any SSE/stream
 * lifecycle, or the one-shot CLI could re-leak a dangling subscription and hang
 * at exit. This test fails the build if a forbidden import sneaks in.
 */
const SRC = fileURLToPath(new URL('.', import.meta.url))

/** Module specifiers a stateless command layer must never import. */
const FORBIDDEN_MODULES = [
  /tui-session/,
  /^@open-consensus\/tui$/,
  /^ink$/,
  /^react$/,
  /^eventsource$/,
]

function sourceFiles(): string[] {
  return readdirSync(SRC)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => fileURLToPath(new URL(f, import.meta.url)))
}

/** Extract every imported module specifier (static, side-effect, and dynamic). */
function importSpecifiers(text: string): string[] {
  const specs: string[] = []
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g, // `import … from 'x'`
    /\bimport\s+['"]([^'"]+)['"]/g, // side-effect `import 'x'`
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic `import('x')`
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // `require('x')`
  ]
  for (const re of patterns) {
    let match: RegExpExecArray | null = re.exec(text)
    while (match !== null) {
      specs.push(match[1] as string)
      match = re.exec(text)
    }
  }
  return specs
}

describe('command-core boundary', () => {
  it('imports no tui-session / SSE / stream-lifecycle module', () => {
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8')
      for (const spec of importSpecifiers(text)) {
        if (FORBIDDEN_MODULES.some((re) => re.test(spec)))
          offenders.push(`${file}: imports ${spec}`)
      }
      // An actual SSE client instantiation (not a comment mention of EventSource).
      if (/new\s+EventSource\b/.test(text)) offenders.push(`${file}: instantiates EventSource`)
    }
    expect(offenders).toEqual([])
  })

  it('actually scans the source files (guards against an empty glob)', () => {
    expect(sourceFiles().length).toBeGreaterThanOrEqual(4)
  })
})
