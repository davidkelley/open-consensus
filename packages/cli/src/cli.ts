#!/usr/bin/env node
// Thin entrypoint for the `open-consensus` binary. All logic lives in
// `program.ts` (coverage-gated). The full slash-command TUI launcher arrives in
// Stage 9; today this is the Stage-2 minimal config CLI.
import { CommanderError } from 'commander'
import { run } from './program'

run(process.argv).catch((err: unknown) => {
  // Commander already printed help/usage for its own errors.
  if (err instanceof CommanderError) {
    process.exitCode = err.exitCode
    return
  }
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
