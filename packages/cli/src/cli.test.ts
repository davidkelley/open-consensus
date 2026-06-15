import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Guards the `open-consensus` bin: the entry must keep its shebang so the
// published binary is directly executable (and so this package's test wiring —
// hence the `no-live` guard + future coverage — is exercised by the suite).
describe('cli entrypoint', () => {
  it('begins with a node shebang', () => {
    const src = readFileSync(fileURLToPath(new URL('./cli.ts', import.meta.url)), 'utf8')
    expect(src.startsWith('#!/usr/bin/env node\n')).toBe(true)
  })
})
