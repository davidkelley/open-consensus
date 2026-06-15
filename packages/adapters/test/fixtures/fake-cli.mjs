#!/usr/bin/env node
// A spawnable fake agent CLI for adapter tests (plan D8/D18): reproduces the
// version probe, stdin/arg prompt delivery, JSON/text/ANSI output, and exit codes
// — driven entirely by FAKE_* env vars, so CI never spawns a real (paid) CLI.
const argv = process.argv.slice(2)
const env = process.env

if (argv.includes('--version') || argv.includes('-v')) {
  if (env.FAKE_VERSION_EXIT) {
    process.stderr.write('bad --version')
    process.exit(Number(env.FAKE_VERSION_EXIT))
  }
  process.stdout.write(`${env.FAKE_VERSION ?? 'fake-cli 9.9.9'}\n`)
  process.exit(0)
}

const mode = env.FAKE_MODE ?? 'ok'
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  stdin += d
})
process.stdin.on('end', () => {
  if (mode === 'timeout') {
    setTimeout(() => {}, 60000) // hang until the runner tree-kills us
    return
  }
  if (mode === 'error') {
    process.stderr.write(env.FAKE_STDERR ?? 'fake error')
    process.exit(Number(env.FAKE_EXIT ?? '1'))
    return
  }
  if (env.FAKE_STDOUT !== undefined) {
    const esc = String.fromCharCode(27)
    // FAKE_ANSI wraps the output in REAL ANSI escapes, so the test proves the
    // runner strips them before the adapter parses.
    const out = env.FAKE_ANSI ? `${esc}[31m${env.FAKE_STDOUT}${esc}[0m` : env.FAKE_STDOUT
    process.stdout.write(out)
  }
  if (env.FAKE_ECHO_STDIN) process.stdout.write(stdin) // assert stdin prompt delivery
  process.exit(0)
})
