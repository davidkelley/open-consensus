#!/usr/bin/env node
// Packaging smoke (plan Stage 10): verify each publishable package's tarball
// includes its declared bin(s) + dist, without a full registry publish (the
// workspace `@open-consensus/*` deps resolve at release time, not here). A full
// install-from-pack into a clean prefix is a release-time step run once the
// packages carry concrete versions.
import { execFileSync } from 'node:child_process'

const PACKAGES = [
  { name: '@open-consensus/cli', bins: ['dist/cli.js'] },
  { name: '@open-consensus/mcp', bins: ['dist/mcp.js', 'dist/index.js'] },
]

let failed = false
for (const pkg of PACKAGES) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '-w', pkg.name], {
    encoding: 'utf8',
  })
  const files = JSON.parse(out)[0].files.map((f) => f.path)
  for (const bin of pkg.bins) {
    if (files.includes(bin)) {
      console.log(`ok   ${pkg.name}: ${bin}`)
    } else {
      console.error(`FAIL ${pkg.name}: missing ${bin} (has: ${files.join(', ')})`)
      failed = true
    }
  }
}

if (failed) {
  console.error('\npackaging smoke failed')
  process.exit(1)
}
console.log('\npackaging smoke passed')
