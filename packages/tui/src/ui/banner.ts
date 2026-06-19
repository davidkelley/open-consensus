import { homedir } from 'node:os'
import { sep } from 'node:path'
import { theme } from '../theme'
import { type Segment, seg } from './segments'

/**
 * Abbreviate the home directory prefix to `~` for a tidy banner. Matches only on a
 * path boundary (home itself, or `home/…`) so a sibling like `/Users/devops`
 * is NOT mangled to `~ops` when home is `/Users/dev`.
 */
function tildify(path: string): string {
  const home = homedir()
  if (!home) return path
  if (path === home) return '~'
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path
}

/**
 * The branded startup banner (plan tui-brand-polish, Stage 4), returned as styled
 * segment-rows so it can be seeded straight into the transcript's `<Static>`
 * scrollback (it scrolls away like Claude Code's banner). Pure: all inputs are
 * passed in, so it is trivially testable without rendering ink.
 */
export function bannerLines(opts: { version?: string; cwd?: string } = {}): Segment[][] {
  const version = opts.version ?? 'dev'
  const cwd = tildify(opts.cwd ?? process.cwd())
  return [
    [
      seg('  ◆ ', { color: theme.brand }),
      seg('OPEN CONSENSUS', { color: theme.brand, bold: true }),
      seg(`  v${version}`, { dim: true }),
    ],
    [seg('    multi-agent consensus execution', { dim: true })],
    [seg(`    ${cwd}`, { dim: true })],
    [seg('')],
    // Orientation only (the WORKFLOW). Mechanical keybindings live in the persistent
    // footer (app.tsx FOOTER_HINT) so the two don't restate /help + Ctrl+C.
    [
      seg('    /help', { color: theme.brand }),
      seg(' for commands · ', { dim: true }),
      seg('/run <panel> <prompt>', { color: theme.brand }),
      seg(' to start', { dim: true }),
    ],
  ]
}
